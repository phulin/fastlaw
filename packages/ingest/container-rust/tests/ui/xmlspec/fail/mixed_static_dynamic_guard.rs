use usc_ingest::xmlspec;

xmlspec! {
    schema MixedGuardSchema {
        record Item
        from tag("item")
        where ancestor(has_attr("kind"))
        {
            value: first_text() where and(tag("value"), parent(tag("item"))),
        }
    }
}

fn main() {}
