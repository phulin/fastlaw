use quick_xml::events::Event;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConstraintKind {
    In(Box<[u8]>),
    MaybeIn(Box<[u8]>),
}

type Bytes = Box<[u8]>;

#[derive(Debug)]
pub struct TrackingMatcher {
    pub kind: ConstraintKind,
    pub attrs: Vec<Bytes>,
    pub bound_attrs: HashMap<Bytes, Bytes>,
    pub depth: usize,
    /// Index of the *next* mandatory matcher in the chain.
    /// If this matcher is itself mandatory, `next_mandatory` points to the *following* mandatory one.
    /// Used to determine the range of matchers to scan when looking for the next match.
    pub next_mandatory: Option<usize>,
}

impl TrackingMatcher {
    fn new(kind: ConstraintKind) -> Self {
        Self {
            kind,
            attrs: Vec::new(),
            bound_attrs: HashMap::new(),
            depth: 0,
            next_mandatory: None,
        }
    }

    pub fn matches(&self, current_tag: &[u8]) -> bool {
        match &self.kind {
            ConstraintKind::In(tag) => tag.as_ref() == current_tag,
            ConstraintKind::MaybeIn(tag) => tag.as_ref() == current_tag,
        }
    }
}

pub type Handler<T> = fn(&mut T, &Event);

pub struct XmlPathFilter<T> {
    matchers: Vec<TrackingMatcher>,
    /// Index of the *deepest* currently active matcher.
    current_matcher: Option<usize>,
    handler: Option<Handler<T>>,
}

impl<T> Default for XmlPathFilter<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T> XmlPathFilter<T> {
    pub fn new() -> Self {
        Self {
            matchers: Vec::new(),
            current_matcher: None,
            handler: None,
        }
    }

    /// Adds a mandatory constraint.
    pub fn in_(&mut self, tag: &str) -> &mut Self {
        self.append(ConstraintKind::In(tag.as_bytes().into()))
    }

    /// Adds an optional constraint.
    pub fn maybe_in(&mut self, tag: &str) -> &mut Self {
        self.append(ConstraintKind::MaybeIn(tag.as_bytes().into()))
    }

    pub fn bind_attr(&mut self, attr: &str) -> &mut Self {
        self.matchers
            .last_mut()
            .expect("bind_attr called without any matchers")
            .attrs
            .push(attr.as_bytes().into());
        self
    }

    fn append(&mut self, kind: ConstraintKind) -> &mut Self {
        let new_idx = self.matchers.len();
        self.matchers.push(TrackingMatcher::new(kind));

        if let ConstraintKind::In(_) = &self.matchers[new_idx].kind {
            for m in self.matchers.iter_mut().take(new_idx) {
                if m.next_mandatory.is_none() {
                    m.next_mandatory = Some(new_idx);
                }
            }
        }

        self
    }

    pub fn set_handler(&mut self, handler: Handler<T>) {
        self.handler = Some(handler);
    }

    pub fn handle_event(&mut self, context: &mut T, event: &Event) {
        match event {
            Event::Start(e) => {
                let name = e.local_name().into_inner();

                let start_idx = self.current_matcher.map(|i| i + 1).unwrap_or(0);
                let end_idx = if let Some(curr) = self.current_matcher {
                    self.matchers[curr]
                        .next_mandatory
                        .unwrap_or(self.matchers.len() - 1)
                } else {
                    self.matchers
                        .iter()
                        .position(|m| matches!(m.kind, ConstraintKind::In(_)))
                        .unwrap_or(self.matchers.len() - 1)
                };

                let mut matched_idx = None;
                if start_idx <= end_idx {
                    for idx in (start_idx..=end_idx).rev() {
                        if idx >= self.matchers.len() {
                            continue;
                        }
                        if self.matchers[idx].matches(name) {
                            matched_idx = Some(idx);
                            break;
                        }
                    }
                }

                if let Some(idx) = matched_idx {
                    self.matchers[idx].depth += 1;
                    self.current_matcher = Some(idx);
                } else {
                    if let Some(curr) = self.current_matcher {
                        if self.matchers[curr].matches(name) {
                            self.matchers[curr].depth += 1;
                        }
                    }
                }
            }
            Event::End(e) => {
                let name = e.local_name().into_inner();
                if let Some(curr) = self.current_matcher {
                    if self.matchers[curr].matches(name) {
                        self.matchers[curr].depth -= 1;

                        // If we just finished the target matcher, fire the handler.
                        if curr == self.matchers.len() - 1 && self.matchers[curr].depth == 0 {
                            if let Some(handler) = self.handler {
                                handler(context, event);
                            }
                        }

                        if self.matchers[curr].depth == 0 {
                            self.current_matcher = self.find_previous_active(curr);
                        }
                    }
                }
            }
            _ => {}
        }

        // Dispatch to handler for active state (Start, Text, recursive End)
        if let Some(last_idx) = self.matchers.len().checked_sub(1) {
            if self.matchers[last_idx].depth > 0 {
                if let Some(handler) = self.handler {
                    handler(context, event);
                }
            }
        }
    }

    fn find_previous_active(&self, current_idx: usize) -> Option<usize> {
        for i in (0..current_idx).rev() {
            if self.matchers[i].depth > 0 {
                return Some(i);
            }
        }
        None
    }
}
