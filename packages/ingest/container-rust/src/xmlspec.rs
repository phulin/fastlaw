use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Selector<Tag> {
    Desc(Tag),
    Child(Tag),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Guard<Tag> {
    True,
    Ancestor(Tag),
    Parent(Tag),
    Not(Box<Guard<Tag>>),
    And(Box<Guard<Tag>>, Box<Guard<Tag>>),
    Or(Box<Guard<Tag>>, Box<Guard<Tag>>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RootSpec<Tag> {
    pub tag: Tag,
    pub guard: Guard<Tag>,
    pub scope_kind: u16,
}

#[derive(Debug, Clone, Copy)]
pub struct StartEvent<'a, Tag> {
    pub tag: Tag,
    pub parent: Option<Tag>,
    pub depth: u32,
    pub attrs: &'a BytesStart<'a>,
}

#[derive(Debug, Clone, Copy)]
pub struct EndEvent<Tag> {
    pub tag: Tag,
    pub parent: Option<Tag>,
    pub depth: u32,
}

#[derive(Debug)]
pub struct EngineView<'a, Tag> {
    stack: &'a [Option<Tag>],
    depths: &'a [u32],
    index_of: fn(Tag) -> usize,
}

impl<'a, Tag> EngineView<'a, Tag>
where
    Tag: Copy + Eq,
{
    pub fn depth(&self) -> u32 {
        self.stack.len() as u32
    }

    pub fn ancestor(&self, tag: Tag) -> bool {
        self.depths[(self.index_of)(tag)] > 0
    }

    pub fn parent(&self, tag: Tag) -> bool {
        self.stack.last().and_then(|t| *t) == Some(tag)
    }
}

pub trait Schema {
    type Tag: Copy + Eq;
    type Scope;
    type Output;

    fn tag_count() -> usize;
    fn tag_index(tag: Self::Tag) -> usize;
    fn intern(bytes: &[u8]) -> Option<Self::Tag>;
    fn roots() -> Vec<RootSpec<Self::Tag>>;
    fn matches_root(root: &RootSpec<Self::Tag>, view: &EngineView<'_, Self::Tag>) -> bool {
        evaluate_guard(&root.guard, view)
    }

    fn open_scope(
        scope_kind: u16,
        root: Self::Tag,
        start: &BytesStart<'_>,
        view: &EngineView<'_, Self::Tag>,
    ) -> Self::Scope;
    fn on_start(
        scope: &mut Self::Scope,
        event: StartEvent<'_, Self::Tag>,
        view: &EngineView<'_, Self::Tag>,
    );
    fn on_text(scope: &mut Self::Scope, text: &[u8]);
    fn on_end(
        scope: &mut Self::Scope,
        event: EndEvent<Self::Tag>,
        view: &EngineView<'_, Self::Tag>,
    );
    fn close_scope(scope: Self::Scope) -> Option<Self::Output>;
}

#[derive(Debug)]
struct ActiveScope<Scope, Tag> {
    root_tag: Tag,
    root_depth: u32,
    state: Scope,
}

pub struct Engine<S: Schema> {
    stack: Vec<Option<S::Tag>>,
    depths: Vec<u32>,
    scopes: Vec<ActiveScope<S::Scope, S::Tag>>,
    roots: Vec<RootSpec<S::Tag>>,
    roots_by_tag: Vec<Vec<usize>>,
}

impl<S: Schema> Default for Engine<S> {
    fn default() -> Self {
        Self::new()
    }
}

impl<S: Schema> Engine<S> {
    pub fn new() -> Self {
        let roots = S::roots();
        let mut roots_by_tag = vec![Vec::new(); S::tag_count()];
        for (idx, root) in roots.iter().enumerate() {
            roots_by_tag[S::tag_index(root.tag)].push(idx);
        }
        Self {
            stack: Vec::new(),
            depths: vec![0; S::tag_count()],
            scopes: Vec::new(),
            roots,
            roots_by_tag,
        }
    }

    pub fn parse_str<F>(&mut self, xml: &str, mut emit: F) -> Result<(), quick_xml::Error>
    where
        F: FnMut(S::Output),
    {
        let mut reader = Reader::from_str(xml);
        reader.config_mut().trim_text(false);

        let mut buf = Vec::new();
        loop {
            match reader.read_event_into(&mut buf)? {
                Event::Start(ref start) => self.handle_start(start),
                Event::Empty(ref start) => {
                    self.handle_start(start);
                    self.handle_end(start.local_name().into_inner(), &mut emit);
                }
                Event::Text(ref text) => {
                    if !self.scopes.is_empty() {
                        let unescaped = text.unescape()?;
                        for scope in &mut self.scopes {
                            S::on_text(&mut scope.state, unescaped.as_bytes());
                        }
                    }
                }
                Event::CData(ref cdata) => {
                    if !self.scopes.is_empty() {
                        for scope in &mut self.scopes {
                            S::on_text(&mut scope.state, cdata.as_ref());
                        }
                    }
                }
                Event::End(ref end) => self.handle_end(end.local_name().into_inner(), &mut emit),
                Event::Eof => break,
                _ => {}
            }
            buf.clear();
        }
        Ok(())
    }

    fn handle_start(&mut self, start: &BytesStart<'_>) {
        let interned = S::intern(start.local_name().into_inner());
        let guard_view = EngineView {
            stack: &self.stack,
            depths: &self.depths,
            index_of: S::tag_index,
        };

        if let Some(tag) = interned {
            let tag_idx = S::tag_index(tag);
            for &root_idx in &self.roots_by_tag[tag_idx] {
                let root = &self.roots[root_idx];
                if S::matches_root(root, &guard_view) {
                    let state = S::open_scope(root.scope_kind, tag, start, &guard_view);
                    let root_depth = self.stack.len() as u32 + 1;
                    self.scopes.push(ActiveScope {
                        root_tag: tag,
                        root_depth,
                        state,
                    });
                }
            }
            self.depths[S::tag_index(tag)] += 1;
        }

        self.stack.push(interned);
        if let Some(tag) = interned {
            let depth = self.stack.len() as u32;
            let parent = self.parent_known_ancestor();
            let view = EngineView {
                stack: &self.stack,
                depths: &self.depths,
                index_of: S::tag_index,
            };
            let event = StartEvent {
                tag,
                parent,
                depth,
                attrs: start,
            };
            for scope in &mut self.scopes {
                S::on_start(&mut scope.state, event, &view);
            }
        }
    }

    fn handle_end<F>(&mut self, raw_name: &[u8], emit: &mut F)
    where
        F: FnMut(S::Output),
    {
        let closing_tag = S::intern(raw_name);
        let depth = self.stack.len() as u32;
        let parent = self.parent_known_ancestor();

        if let Some(tag) = closing_tag {
            let view = EngineView {
                stack: &self.stack,
                depths: &self.depths,
                index_of: S::tag_index,
            };
            let event = EndEvent { tag, parent, depth };
            for scope in &mut self.scopes {
                S::on_end(&mut scope.state, event, &view);
            }
        }

        while let Some(scope) = self.scopes.last() {
            if closing_tag == Some(scope.root_tag) && depth == scope.root_depth {
                let scope = self.scopes.pop().expect("scope stack is not empty");
                if let Some(output) = S::close_scope(scope.state) {
                    emit(output);
                }
            } else {
                break;
            }
        }

        if let Some(top) = self.stack.pop().flatten() {
            self.depths[S::tag_index(top)] -= 1;
        }
    }

    fn parent_known_ancestor(&self) -> Option<S::Tag> {
        self.stack.iter().rev().skip(1).find_map(|entry| *entry)
    }
}

pub fn evaluate_guard<Tag>(guard: &Guard<Tag>, view: &EngineView<'_, Tag>) -> bool
where
    Tag: Copy + Eq,
{
    match guard {
        Guard::True => true,
        Guard::Ancestor(tag) => view.ancestor(*tag),
        Guard::Parent(tag) => view.parent(*tag),
        Guard::Not(inner) => !evaluate_guard(inner, view),
        Guard::And(left, right) => evaluate_guard(left, view) && evaluate_guard(right, view),
        Guard::Or(left, right) => evaluate_guard(left, view) || evaluate_guard(right, view),
    }
}

pub fn normalize_text(text: &[u8]) -> String {
    String::from_utf8_lossy(text)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

pub fn selector_matches<Tag>(
    selector: Selector<Tag>,
    root_depth: u32,
    event_depth: u32,
    tag: Tag,
) -> bool
where
    Tag: Copy + Eq,
{
    match selector {
        Selector::Desc(target) => event_depth > root_depth && tag == target,
        Selector::Child(target) => event_depth == root_depth + 1 && tag == target,
    }
}

#[derive(Debug, Clone)]
pub struct FirstTextReducer<Tag> {
    selector: Selector<Tag>,
    root_depth: u32,
    active_depths: Vec<u32>,
    buffer: Vec<u8>,
    value: Option<String>,
}

impl<Tag> FirstTextReducer<Tag>
where
    Tag: Copy + Eq,
{
    pub fn new(selector: Selector<Tag>, root_depth: u32) -> Self {
        Self {
            selector,
            root_depth,
            active_depths: Vec::new(),
            buffer: Vec::new(),
            value: None,
        }
    }

    pub fn on_start(&mut self, tag: Tag, depth: u32) {
        if self.value.is_some() {
            return;
        }
        if selector_matches(self.selector, self.root_depth, depth, tag) {
            self.active_depths.push(depth);
        }
    }

    pub fn on_text(&mut self, text: &[u8]) {
        if self.value.is_none() && !self.active_depths.is_empty() {
            self.buffer.extend_from_slice(text);
        }
    }

    pub fn on_end(&mut self, depth: u32) {
        if self.value.is_some() {
            return;
        }
        if self.active_depths.last().copied() == Some(depth) {
            self.active_depths.pop();
            if self.active_depths.is_empty() {
                let normalized = normalize_text(&self.buffer);
                self.buffer.clear();
                if !normalized.is_empty() {
                    self.value = Some(normalized);
                }
            }
        }
    }

    pub fn take(self) -> Option<String> {
        self.value
    }

    pub fn peek(&self) -> Option<&str> {
        self.value.as_deref()
    }
}

#[derive(Debug, Clone)]
pub struct AllTextReducer<Tag> {
    selector: Selector<Tag>,
    root_depth: u32,
    active_depths: Vec<u32>,
    buffer: Vec<u8>,
    values: Vec<String>,
}

impl<Tag> AllTextReducer<Tag>
where
    Tag: Copy + Eq,
{
    pub fn new(selector: Selector<Tag>, root_depth: u32) -> Self {
        Self {
            selector,
            root_depth,
            active_depths: Vec::new(),
            buffer: Vec::new(),
            values: Vec::new(),
        }
    }

    pub fn on_start(&mut self, tag: Tag, depth: u32) {
        if selector_matches(self.selector, self.root_depth, depth, tag) {
            self.active_depths.push(depth);
        }
    }

    pub fn on_text(&mut self, text: &[u8]) {
        if !self.active_depths.is_empty() {
            self.buffer.extend_from_slice(text);
        }
    }

    pub fn on_end(&mut self, depth: u32) {
        if self.active_depths.last().copied() == Some(depth) {
            self.active_depths.pop();
            if self.active_depths.is_empty() {
                let normalized = normalize_text(&self.buffer);
                self.buffer.clear();
                if !normalized.is_empty() {
                    self.values.push(normalized);
                }
            }
        }
    }

    pub fn take(self) -> Vec<String> {
        self.values
    }
}

#[derive(Debug, Clone)]
pub struct TextReducer<Tag> {
    selector: Selector<Tag>,
    except: Vec<Selector<Tag>>,
    root_depth: u32,
    active_depths: Vec<u32>,
    excluded_depths: Vec<u32>,
    buffer: Vec<u8>,
    value: Option<String>,
}

impl<Tag> TextReducer<Tag>
where
    Tag: Copy + Eq,
{
    pub fn new(selector: Selector<Tag>, except: Vec<Selector<Tag>>, root_depth: u32) -> Self {
        Self {
            selector,
            except,
            root_depth,
            active_depths: Vec::new(),
            excluded_depths: Vec::new(),
            buffer: Vec::new(),
            value: None,
        }
    }

    pub fn on_start(&mut self, tag: Tag, depth: u32) {
        if selector_matches(self.selector, self.root_depth, depth, tag) {
            self.active_depths.push(depth);
        }
        for selector in &self.except {
            if selector_matches(*selector, self.root_depth, depth, tag) {
                self.excluded_depths.push(depth);
            }
        }
    }

    pub fn on_text(&mut self, text: &[u8]) {
        if !self.active_depths.is_empty() && self.excluded_depths.is_empty() {
            self.buffer.extend_from_slice(text);
        }
    }

    pub fn on_end(&mut self, depth: u32) {
        if self.excluded_depths.last().copied() == Some(depth) {
            self.excluded_depths.pop();
        }
        if self.active_depths.last().copied() == Some(depth) {
            self.active_depths.pop();
            if self.active_depths.is_empty() {
                let normalized = normalize_text(&self.buffer);
                self.buffer.clear();
                if !normalized.is_empty() {
                    self.value = Some(match self.value.take() {
                        Some(existing) => format!("{existing}\n\n{normalized}"),
                        None => normalized,
                    });
                }
            }
        }
    }

    pub fn take(self) -> Option<String> {
        self.value
    }
}

#[derive(Debug, Clone)]
pub struct AttrReducer {
    attr_name: &'static [u8],
    value: Option<String>,
}

impl AttrReducer {
    pub fn new(attr_name: &'static [u8]) -> Self {
        Self {
            attr_name,
            value: None,
        }
    }

    pub fn capture(&mut self, start: &BytesStart<'_>) {
        if self.value.is_some() {
            return;
        }
        for attr in start.attributes().flatten() {
            if attr.key.as_ref() == self.attr_name {
                self.value = Some(String::from_utf8_lossy(attr.value.as_ref()).to_string());
                break;
            }
        }
    }

    pub fn take(self) -> Option<String> {
        self.value
    }
}
