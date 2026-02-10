use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

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

    pub fn parent_of_depth(&self, tag: Tag, depth: u32) -> bool {
        if depth < 2 {
            return false;
        }
        self.stack.get(depth as usize - 2).and_then(|t| *t) == Some(tag)
    }

    pub fn ancestor_of_depth(&self, tag: Tag, depth: u32) -> bool {
        if depth < 2 {
            return false;
        }
        self.stack
            .iter()
            .take(depth as usize - 1)
            .any(|candidate| *candidate == Some(tag))
    }

    pub fn parent(&self, tag: Tag) -> bool {
        self.parent_of_depth(tag, self.depth() + 1)
    }

    pub fn ancestor(&self, tag: Tag) -> bool {
        self.depths[(self.index_of)(tag)] > 0
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
    fn matches_root(
        root: &RootSpec<Self::Tag>,
        start: &BytesStart<'_>,
        view: &EngineView<'_, Self::Tag>,
    ) -> bool {
        let _ = start;
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
                if S::matches_root(root, start, &guard_view) {
                    let state = S::open_scope(root.scope_kind, tag, start, &guard_view);
                    let root_depth = self.stack.len() as u32 + 1;
                    self.scopes.push(ActiveScope {
                        root_tag: tag,
                        root_depth,
                        state,
                    });
                }
            }
            self.depths[tag_idx] += 1;
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

#[derive(Debug, Clone)]
pub struct FirstTextReducer {
    active_depths: Vec<u32>,
    buffer: Vec<u8>,
    value: Option<String>,
}

impl FirstTextReducer {
    pub fn new() -> Self {
        Self {
            active_depths: Vec::new(),
            buffer: Vec::new(),
            value: None,
        }
    }

    pub fn on_start(&mut self, matches_selector: bool, depth: u32) {
        if self.value.is_some() {
            return;
        }
        if matches_selector {
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
}

impl Default for FirstTextReducer {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub struct AllTextReducer {
    active_depths: Vec<u32>,
    buffer: Vec<u8>,
    values: Vec<String>,
}

impl AllTextReducer {
    pub fn new() -> Self {
        Self {
            active_depths: Vec::new(),
            buffer: Vec::new(),
            values: Vec::new(),
        }
    }

    pub fn on_start(&mut self, matches_selector: bool, depth: u32) {
        if matches_selector {
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

impl Default for AllTextReducer {
    fn default() -> Self {
        Self::new()
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

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FragmentChunk {
    Text(String),
    Styled(u16, String),
}

#[derive(Debug, Clone)]
pub struct AllFragmentsReducer<Tag> {
    inline_rules: Vec<(Tag, u16)>,
    active_depths: Vec<u32>,
    styles: Vec<(u32, u16)>,
    buffer: Vec<u8>,
    chunks: Vec<FragmentChunk>,
}

impl<Tag> AllFragmentsReducer<Tag>
where
    Tag: Copy + Eq,
{
    pub fn new(inline_rules: Vec<(Tag, u16)>) -> Self {
        Self {
            inline_rules,
            active_depths: Vec::new(),
            styles: Vec::new(),
            buffer: Vec::new(),
            chunks: Vec::new(),
        }
    }

    pub fn inline_kind_for_tag(&self, tag: Tag) -> Option<u16> {
        self.inline_rules
            .iter()
            .find_map(|(candidate, kind)| (*candidate == tag).then_some(*kind))
    }

    pub fn on_start(&mut self, matches_selector: bool, depth: u32, inline_kind: Option<u16>) {
        if matches_selector {
            self.active_depths.push(depth);
        }
        if self.active_depths.is_empty() {
            return;
        }
        if let Some(kind) = inline_kind {
            self.flush();
            self.styles.push((depth, kind));
        }
    }

    pub fn on_text(&mut self, text: &[u8]) {
        if !self.active_depths.is_empty() {
            self.buffer.extend_from_slice(text);
        }
    }

    pub fn on_end(&mut self, depth: u32) {
        if self.styles.last().copied().map(|(d, _)| d) == Some(depth) {
            self.flush();
            self.styles.pop();
        }
        if self.active_depths.last().copied() == Some(depth) {
            self.flush();
            self.active_depths.pop();
        }
    }

    pub fn take(mut self) -> Vec<FragmentChunk> {
        self.flush();
        self.chunks
    }

    fn flush(&mut self) {
        if self.buffer.is_empty() {
            return;
        }
        let normalized = normalize_text(&self.buffer);
        self.buffer.clear();
        if normalized.is_empty() {
            return;
        }
        if let Some((_, kind)) = self.styles.last().copied() {
            self.chunks.push(FragmentChunk::Styled(kind, normalized));
        } else {
            self.chunks.push(FragmentChunk::Text(normalized));
        }
    }
}
