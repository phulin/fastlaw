use usc_ingest::xmlspec;

xmlspec! {
    schema BadTextExcept {
        record Item
        from tag("item")
        {
            value: text(desc("value"), bad(desc("note"))),
        }
    }
}

fn main() {}
