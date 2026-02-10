use usc_ingest::xmlspec;

xmlspec! {
    schema MixedGuardSchema {
        record Item
        from tag("item")
        where parent("doc") and attr("kind") == "x"
        {
            value: first_text(child("value")),
        }
    }
}

fn main() {}
