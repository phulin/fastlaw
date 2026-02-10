use usc_ingest::xmlspec;

xmlspec! {
    schema BadExtractor {
        record Item
        from tag("item")
        {
            value: text(desc("value")),
        }
    }
}

fn main() {}
