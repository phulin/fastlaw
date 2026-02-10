use usc_ingest::xmlspec;

xmlspec! {
    schema BadExtractor {
        record Item
        from tag("item")
        {
            value: unknown() where tag("value"),
        }
    }
}

fn main() {}
