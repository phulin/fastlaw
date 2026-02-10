use usc_ingest::xmlspec;

xmlspec! {
    schema BadGuard {
        record Item
        from tag("item")
        where false
        {
            value: first_text(child("value")),
        }
    }
}

fn main() {}
