use usc_ingest::xmlspec::Engine;

usc_ingest::xmlspec! {
    schema TextExceptSchema {
        record Item
        from tag("item")
        {
            body: all_text() where tag("p"),
        }
    }
}

fn main() {
    let mut engine = Engine::<TextExceptSchema>::new();
    let mut out = Vec::<TextExceptSchemaOutput>::new();
    engine
        .parse_str("<item><p>a</p><note><p>b</p></note><p>c</p></item>", |item| out.push(item))
        .expect("parse");
    assert_eq!(out.len(), 1);
}
