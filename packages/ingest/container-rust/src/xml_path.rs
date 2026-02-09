use quick_xml::events::Event;
use std::collections::HashMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConstraintKind {
    In,
    NotIn,
}

type Bytes = Box<[u8]>;

#[derive(Debug)]
pub struct TrackingMatcher {
    pub kind: ConstraintKind,
    pub tags: Vec<Bytes>,
    pub attrs: Vec<Bytes>,
    pub bound_attrs: HashMap<Bytes, Bytes>,
    pub depth: usize,
}

impl TrackingMatcher {
    fn new(kind: ConstraintKind, tags: Vec<Bytes>) -> Self {
        Self {
            kind,
            tags,
            attrs: Vec::new(),
            bound_attrs: HashMap::new(),
            depth: 0,
        }
    }

    pub fn matches(&self, current_tag: &[u8]) -> bool {
        match self.kind {
            ConstraintKind::In => self.tags.iter().any(|t| t.as_ref() == current_tag),
            ConstraintKind::NotIn => {
                self.depth == 0 && !self.tags.iter().any(|t| t.as_ref() == current_tag)
            }
        }
    }
}

pub type Handler = fn(&Event);

pub struct XmlPathFilter {
    matchers: Vec<TrackingMatcher>,
    current_matcher: usize,
    handler: Option<Handler>,
}

impl XmlPathFilter {
    pub fn in_(&mut self, tag: &str) -> &mut Self {
        self.append(ConstraintKind::In, vec![tag.as_bytes().into()])
    }

    pub fn in_any(&mut self, tags: &[&str]) -> &mut Self {
        self.append(
            ConstraintKind::In,
            tags.iter().map(|s| s.as_bytes().into()).collect(),
        )
    }

    pub fn not_in(&mut self, tag: &str) -> &mut Self {
        self.append(ConstraintKind::NotIn, vec![tag.as_bytes().into()])
    }

    pub fn not_in_any(&mut self, tags: &[&str]) -> &mut Self {
        self.append(
            ConstraintKind::NotIn,
            tags.iter().map(|s| s.as_bytes().into()).collect(),
        )
    }

    pub fn bind_attr(&mut self, attr: &str) -> &mut Self {
        self.matchers
            .last_mut()
            .expect("bind_attr called without any matchers")
            .attrs
            .push(attr.as_bytes().into());
        self
    }

    fn append(&mut self, kind: ConstraintKind, tags: Vec<Bytes>) -> &mut Self {
        self.matchers.push(TrackingMatcher::new(kind, tags));
        self
    }

    pub fn set_handler(&mut self, handler: Handler) {
        self.handler = Some(handler);
    }

    pub fn handle_event(&mut self, event: &Event) {
        match event {
            Event::Start(e) => {
                let name = e.local_name().into_inner();
                let current = &mut self.matchers[self.current_matcher];
                if current.matches(name) {
                    current.depth += 1;
                    self.current_matcher =
                        std::cmp::min(self.current_matcher + 1, self.matchers.len() - 1);
                }
            }
            Event::End(e) => {
                let name = e.local_name().into_inner();
                let current = &mut self.matchers[self.current_matcher];
                if current.matches(name) {
                    assert!(current.depth > 0);
                    current.depth -= 1;
                    if current.depth == 0 {
                        self.current_matcher =
                            std::cmp::min(self.current_matcher + 1, self.matchers.len() - 1);
                    }
                    // Check below will no longer be true, so match here.
                    match self.handler {
                        Some(handler) => handler(event),
                        None => {}
                    }
                }
            }
            _ => {}
        };
        if self.current_matcher == self.matchers.len() - 1
            && self.matchers[self.current_matcher].depth > 0
        {
            match self.handler {
                Some(handler) => handler(event),
                None => {}
            }
        }
    }
}
