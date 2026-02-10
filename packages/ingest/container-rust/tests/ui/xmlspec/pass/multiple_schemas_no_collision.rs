use usc_ingest::xmlspec::Engine;

usc_ingest::xmlspec! {
    schema FirstSchema {
        record One
        from tag("item")
        where true
        {
            value: first_text(child("value")),
        }
    }
}

usc_ingest::xmlspec! {
    schema SecondSchema {
        record Two
        from tag("item")
        where true
        {
            kind: attr("kind"),
        }
    }
}

fn main() {
    let mut a = Engine::<FirstSchema>::new();
    let mut b = Engine::<SecondSchema>::new();
    let mut ao = Vec::<FirstSchemaOutput>::new();
    let mut bo = Vec::<SecondSchemaOutput>::new();

    a.parse_str("<item><value>x</value></item>", |out| ao.push(out))
        .expect("parse");
    b.parse_str("<item kind=\"k\"/>", |out| bo.push(out))
        .expect("parse");

    assert_eq!(ao.len(), 1);
    assert_eq!(bo.len(), 1);
}
