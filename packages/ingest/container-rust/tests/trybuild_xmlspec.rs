#[test]
fn xmlspec_ui() {
    let t = trybuild::TestCases::new();
    t.pass("tests/ui/xmlspec/pass/*.rs");
    t.compile_fail("tests/ui/xmlspec/fail/*.rs");
}
