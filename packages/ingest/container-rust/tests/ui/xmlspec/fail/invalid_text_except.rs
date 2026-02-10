use usc_ingest::xmlspec;

xmlspec! {
    schema BadTextExcept {
        record Item
        from tag("item")
        {
            value: first_text() where tag("value") inline {
                has_attr("x") => Marked,
            },
        }
    }
}

fn main() {}
