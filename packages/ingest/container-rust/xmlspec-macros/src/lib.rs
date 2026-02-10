use proc_macro::TokenStream;
use quote::{format_ident, quote};
use syn::parse::{Parse, ParseStream};
use syn::{
    braced, parenthesized, parse_macro_input, Error, Ident, LitBool, LitByteStr, LitStr, Result,
    Token,
};

#[proc_macro]
pub fn xmlspec(input: TokenStream) -> TokenStream {
    let spec = parse_macro_input!(input as XmlSpecInput);
    expand_xmlspec(spec).unwrap_or_else(Error::into_compile_error).into()
}

struct XmlSpecInput {
    schema_name: Ident,
    records: Vec<RecordSpec>,
}

struct RecordSpec {
    name: Ident,
    root_tag: LitStr,
    guard: GuardExpr,
    fields: Vec<FieldSpec>,
}

struct FieldSpec {
    name: Ident,
    extractor: ExtractorSpec,
}

enum ExtractorSpec {
    FirstText(SelectorSpec),
    AllText(SelectorSpec),
    Attr(LitStr),
}

enum SelectorSpec {
    Desc(LitStr),
    Child(LitStr),
}

#[derive(Clone)]
enum GuardExpr {
    True,
    Ancestor(LitStr),
    Parent(LitStr),
    Not(Box<GuardExpr>),
    And(Box<GuardExpr>, Box<GuardExpr>),
    Or(Box<GuardExpr>, Box<GuardExpr>),
}

impl Parse for XmlSpecInput {
    fn parse(input: ParseStream<'_>) -> Result<Self> {
        expect_ident(input, "schema")?;
        let schema_name: Ident = input.parse()?;
        let content;
        braced!(content in input);

        let mut records = Vec::new();
        while !content.is_empty() {
            records.push(content.parse()?);
        }

        if records.is_empty() {
            return Err(Error::new(
                schema_name.span(),
                "schema must define at least one record",
            ));
        }

        Ok(Self {
            schema_name,
            records,
        })
    }
}

impl Parse for RecordSpec {
    fn parse(input: ParseStream<'_>) -> Result<Self> {
        expect_ident(input, "record")?;
        let name: Ident = input.parse()?;
        expect_ident(input, "from")?;

        let root_tag = parse_tag_call(input)?;

        let guard = if input.peek(Token![where]) {
            input.parse::<Token![where]>()?;
            parse_guard_expr(input)?
        } else {
            GuardExpr::True
        };

        let content;
        braced!(content in input);
        let mut fields = Vec::new();
        while !content.is_empty() {
            fields.push(content.parse()?);
        }

        if fields.is_empty() {
            return Err(Error::new(name.span(), "record must define at least one field"));
        }

        Ok(Self {
            name,
            root_tag,
            guard,
            fields,
        })
    }
}

impl Parse for FieldSpec {
    fn parse(input: ParseStream<'_>) -> Result<Self> {
        let name: Ident = input.parse()?;
        input.parse::<Token![:]>()?;
        let extractor = parse_extractor(input)?;
        input.parse::<Token![,]>()?;
        Ok(Self { name, extractor })
    }
}

fn parse_tag_call(input: ParseStream<'_>) -> Result<LitStr> {
    let fn_name: Ident = input.parse()?;
    if fn_name != "tag" {
        return Err(Error::new(fn_name.span(), "expected tag(\"...\")"));
    }
    let inner;
    parenthesized!(inner in input);
    inner.parse()
}

fn parse_extractor(input: ParseStream<'_>) -> Result<ExtractorSpec> {
    let name: Ident = input.parse()?;
    let inner;
    parenthesized!(inner in input);
    match name.to_string().as_str() {
        "first_text" => Ok(ExtractorSpec::FirstText(parse_selector(&inner)?)),
        "all_text" => Ok(ExtractorSpec::AllText(parse_selector(&inner)?)),
        "attr" => Ok(ExtractorSpec::Attr(inner.parse()?)),
        _ => Err(Error::new(
            name.span(),
            "expected first_text(...), all_text(...), or attr(\"...\")",
        )),
    }
}

fn parse_selector(input: ParseStream<'_>) -> Result<SelectorSpec> {
    let name: Ident = input.parse()?;
    let inner;
    parenthesized!(inner in input);
    match name.to_string().as_str() {
        "desc" => Ok(SelectorSpec::Desc(inner.parse()?)),
        "child" => Ok(SelectorSpec::Child(inner.parse()?)),
        _ => Err(Error::new(name.span(), "expected desc(\"...\") or child(\"...\")")),
    }
}

fn parse_guard_expr(input: ParseStream<'_>) -> Result<GuardExpr> {
    parse_guard_or(input)
}

fn parse_guard_or(input: ParseStream<'_>) -> Result<GuardExpr> {
    let mut expr = parse_guard_and(input)?;
    while peek_ident(input, "or") {
        expect_ident(input, "or")?;
        let rhs = parse_guard_and(input)?;
        expr = GuardExpr::Or(Box::new(expr), Box::new(rhs));
    }
    Ok(expr)
}

fn parse_guard_and(input: ParseStream<'_>) -> Result<GuardExpr> {
    let mut expr = parse_guard_unary(input)?;
    while peek_ident(input, "and") {
        expect_ident(input, "and")?;
        let rhs = parse_guard_unary(input)?;
        expr = GuardExpr::And(Box::new(expr), Box::new(rhs));
    }
    Ok(expr)
}

fn parse_guard_unary(input: ParseStream<'_>) -> Result<GuardExpr> {
    if peek_ident(input, "not") {
        expect_ident(input, "not")?;
        let inner;
        parenthesized!(inner in input);
        return Ok(GuardExpr::Not(Box::new(parse_guard_expr(&inner)?)));
    }

    if input.peek(syn::token::Paren) {
        let inner;
        parenthesized!(inner in input);
        return parse_guard_expr(&inner);
    }

    parse_guard_primary(input)
}

fn parse_guard_primary(input: ParseStream<'_>) -> Result<GuardExpr> {
    if input.peek(LitBool) {
        let lit = input.parse::<LitBool>()?;
        if lit.value {
            return Ok(GuardExpr::True);
        }
        return Err(Error::new(lit.span(), "only `true` is allowed in guard expressions"));
    }

    let ident: Ident = input.parse()?;
    match ident.to_string().as_str() {
        "ancestor" => {
            let inner;
            parenthesized!(inner in input);
            Ok(GuardExpr::Ancestor(inner.parse()?))
        }
        "parent" => {
            let inner;
            parenthesized!(inner in input);
            Ok(GuardExpr::Parent(inner.parse()?))
        }
        _ => Err(Error::new(
            ident.span(),
            "expected true, ancestor(\"...\"), parent(\"...\"), not(...), and/or",
        )),
    }
}

fn expand_xmlspec(spec: XmlSpecInput) -> Result<proc_macro2::TokenStream> {
    let schema_name = spec.schema_name;
    let tag_enum_name = format_ident!("{}Tag", schema_name);
    let scope_enum_name = format_ident!("{}Scope", schema_name);
    let output_enum_name = format_ident!("{}Output", schema_name);

    let mut all_tags = Vec::<String>::new();
    for record in &spec.records {
        push_tag(&mut all_tags, &record.root_tag.value());
        collect_guard_tags(&mut all_tags, &record.guard);
        for field in &record.fields {
            match &field.extractor {
                ExtractorSpec::FirstText(selector) | ExtractorSpec::AllText(selector) => {
                    let tag = match selector {
                        SelectorSpec::Desc(tag) | SelectorSpec::Child(tag) => tag.value(),
                    };
                    push_tag(&mut all_tags, &tag);
                }
                ExtractorSpec::Attr(_) => {}
            }
        }
    }

    let mut variants = Vec::new();
    for tag in &all_tags {
        variants.push(format_ident!("{}", tag_to_variant(tag)));
    }

    let tag_match_arms = all_tags.iter().zip(variants.iter()).map(|(tag, variant)| {
        let tag_bytes = LitByteStr::new(tag.as_bytes(), proc_macro2::Span::call_site());
        quote! { #tag_bytes => Some(#tag_enum_name::#variant), }
    });
    let tag_count = variants.len();

    let roots = spec.records.iter().enumerate().map(|(idx, record)| {
        let root_variant = variant_for_tag(&all_tags, &variants, &record.root_tag.value());
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        quote! {
            ::usc_ingest::xmlspec::RootSpec {
                tag: #tag_enum_name::#root_variant,
                guard: ::usc_ingest::xmlspec::Guard::True,
                scope_kind: #scope_kind,
            }
        }
    });

    let matches_root_arms = spec.records.iter().enumerate().map(|(idx, record)| {
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        let guard_check = guard_check_tokens(&record.guard, &all_tags, &variants, &tag_enum_name);
        quote! {
            #scope_kind => #guard_check,
        }
    });

    let scope_variants = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        quote! { #state_name(#state_name) }
    });

    let state_structs = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let reducers = record.fields.iter().map(|field| {
            let field_name = &field.name;
            let ty = reducer_type_tokens(&field.extractor, &tag_enum_name);
            quote! { #field_name: #ty }
        });
        quote! {
            pub struct #state_name {
                #(#reducers,)*
            }
        }
    });

    let open_scope_arms = spec.records.iter().enumerate().map(|(idx, record)| {
        let state_name = format_ident!("{}State", record.name);
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        let field_inits = record.fields.iter().map(|field| {
            let field_name = &field.name;
            let init = reducer_init_tokens(&field.extractor, &all_tags, &variants, &tag_enum_name);
            quote! { #field_name: #init }
        });
        quote! {
            #scope_kind => #scope_enum_name::#state_name(#state_name {
                #(#field_inits,)*
            }),
        }
    });

    let on_start_arms = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let reducer_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            if matches!(&field.extractor, ExtractorSpec::Attr(_)) {
                quote! {}
            } else {
                quote! { state.#field_name.on_start(event.tag, event.depth); }
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#reducer_calls)*
            }
        }
    });

    let on_text_arms = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let reducer_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            if matches!(&field.extractor, ExtractorSpec::Attr(_)) {
                quote! {}
            } else {
                quote! { state.#field_name.on_text(text); }
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#reducer_calls)*
            }
        }
    });

    let on_end_arms = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let reducer_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            if matches!(&field.extractor, ExtractorSpec::Attr(_)) {
                quote! {}
            } else {
                quote! { state.#field_name.on_end(event.depth); }
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#reducer_calls)*
            }
        }
    });

    let output_enum_variants = spec.records.iter().map(|record| {
        let record_name = &record.name;
        quote! { #record_name(#record_name) }
    });

    let output_structs = spec.records.iter().map(|record| {
        let record_name = &record.name;
        let fields = record.fields.iter().map(|field| {
            let field_name = &field.name;
            let ty = output_field_type_tokens(&field.extractor);
            quote! { pub #field_name: #ty }
        });
        quote! {
            #[derive(Debug, Clone, PartialEq, Eq)]
            pub struct #record_name {
                #(#fields,)*
            }
        }
    });

    let close_scope_arms = spec.records.iter().map(|record| {
        let record_name = &record.name;
        let state_name = format_ident!("{}State", record.name);
        let fields = record.fields.iter().map(|field| {
            let field_name = &field.name;
            quote! { #field_name: state.#field_name.take() }
        });
        quote! {
            #scope_enum_name::#state_name(state) => Some(#output_enum_name::#record_name(#record_name {
                #(#fields,)*
            })),
        }
    });

    let tag_indices = variants.iter().enumerate().map(|(idx, variant)| {
        quote! { #tag_enum_name::#variant => #idx, }
    });

    Ok(quote! {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum #tag_enum_name {
            #(#variants,)*
        }

        #(#output_structs)*

        #[derive(Debug, Clone, PartialEq, Eq)]
        pub enum #output_enum_name {
            #(#output_enum_variants,)*
        }

        #(#state_structs)*

        pub enum #scope_enum_name {
            #(#scope_variants,)*
        }

        pub struct #schema_name;

        impl ::usc_ingest::xmlspec::Schema for #schema_name {
            type Tag = #tag_enum_name;
            type Scope = #scope_enum_name;
            type Output = #output_enum_name;

            fn tag_count() -> usize {
                #tag_count
            }

            fn tag_index(tag: Self::Tag) -> usize {
                match tag {
                    #(#tag_indices)*
                }
            }

            fn intern(bytes: &[u8]) -> Option<Self::Tag> {
                match bytes {
                    #(#tag_match_arms)*
                    _ => None,
                }
            }

            fn roots() -> Vec<::usc_ingest::xmlspec::RootSpec<Self::Tag>> {
                vec![#(#roots),*]
            }

            fn matches_root(
                root: &::usc_ingest::xmlspec::RootSpec<Self::Tag>,
                view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) -> bool {
                match root.scope_kind {
                    #(#matches_root_arms)*
                    _ => false,
                }
            }

            fn open_scope(
                scope_kind: u16,
                _root: Self::Tag,
                start: &quick_xml::events::BytesStart<'_>,
                view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) -> Self::Scope {
                let root_depth = view.depth() + 1;
                match scope_kind {
                    #(#open_scope_arms)*
                    _ => panic!("scope kind not declared in roots"),
                }
            }

            fn on_start(
                scope: &mut Self::Scope,
                event: ::usc_ingest::xmlspec::StartEvent<'_, Self::Tag>,
                _view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) {
                match scope {
                    #(#on_start_arms)*
                }
            }

            fn on_text(scope: &mut Self::Scope, text: &[u8]) {
                match scope {
                    #(#on_text_arms)*
                }
            }

            fn on_end(
                scope: &mut Self::Scope,
                event: ::usc_ingest::xmlspec::EndEvent<Self::Tag>,
                _view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) {
                match scope {
                    #(#on_end_arms)*
                }
            }

            fn close_scope(scope: Self::Scope) -> Option<Self::Output> {
                match scope {
                    #(#close_scope_arms)*
                }
            }
        }
    })
}

fn reducer_type_tokens(
    extractor: &ExtractorSpec,
    tag_enum_name: &Ident,
) -> proc_macro2::TokenStream {
    match extractor {
        ExtractorSpec::FirstText(_) => quote! { ::usc_ingest::xmlspec::FirstTextReducer<#tag_enum_name> },
        ExtractorSpec::AllText(_) => quote! { ::usc_ingest::xmlspec::AllTextReducer<#tag_enum_name> },
        ExtractorSpec::Attr(_) => quote! { ::usc_ingest::xmlspec::AttrReducer },
    }
}

fn reducer_init_tokens(
    extractor: &ExtractorSpec,
    all_tags: &[String],
    variants: &[Ident],
    tag_enum_name: &Ident,
) -> proc_macro2::TokenStream {
    match extractor {
        ExtractorSpec::FirstText(selector) => {
            let sel = selector_tokens(selector, all_tags, variants, tag_enum_name);
            quote! { ::usc_ingest::xmlspec::FirstTextReducer::new(#sel, root_depth) }
        }
        ExtractorSpec::AllText(selector) => {
            let sel = selector_tokens(selector, all_tags, variants, tag_enum_name);
            quote! { ::usc_ingest::xmlspec::AllTextReducer::new(#sel, root_depth) }
        }
        ExtractorSpec::Attr(attr) => {
            let attr_value = attr.value();
            let attr_bytes = LitByteStr::new(attr_value.as_bytes(), attr.span());
            quote! {{
                let mut reducer = ::usc_ingest::xmlspec::AttrReducer::new(#attr_bytes);
                reducer.capture(start);
                reducer
            }}
        }
    }
}

fn output_field_type_tokens(extractor: &ExtractorSpec) -> proc_macro2::TokenStream {
    match extractor {
        ExtractorSpec::FirstText(_) | ExtractorSpec::Attr(_) => quote! { Option<String> },
        ExtractorSpec::AllText(_) => quote! { Vec<String> },
    }
}

fn selector_tokens(
    selector: &SelectorSpec,
    all_tags: &[String],
    variants: &[Ident],
    tag_enum_name: &Ident,
) -> proc_macro2::TokenStream {
    match selector {
        SelectorSpec::Desc(tag) => {
            let variant = variant_for_tag(all_tags, variants, &tag.value());
            quote! { ::usc_ingest::xmlspec::Selector::Desc(#tag_enum_name::#variant) }
        }
        SelectorSpec::Child(tag) => {
            let variant = variant_for_tag(all_tags, variants, &tag.value());
            quote! { ::usc_ingest::xmlspec::Selector::Child(#tag_enum_name::#variant) }
        }
    }
}

fn guard_check_tokens(
    guard: &GuardExpr,
    all_tags: &[String],
    variants: &[Ident],
    tag_enum_name: &Ident,
) -> proc_macro2::TokenStream {
    match guard {
        GuardExpr::True => quote! { true },
        GuardExpr::Ancestor(tag) => {
            let variant = variant_for_tag(all_tags, variants, &tag.value());
            quote! {
                view.ancestor(#tag_enum_name::#variant)
            }
        }
        GuardExpr::Parent(tag) => {
            let variant = variant_for_tag(all_tags, variants, &tag.value());
            quote! {
                view.parent(#tag_enum_name::#variant)
            }
        }
        GuardExpr::Not(inner) => {
            let inner_tokens = guard_check_tokens(inner, all_tags, variants, tag_enum_name);
            quote! { !(#inner_tokens) }
        }
        GuardExpr::And(left, right) => {
            let left_tokens = guard_check_tokens(left, all_tags, variants, tag_enum_name);
            let right_tokens = guard_check_tokens(right, all_tags, variants, tag_enum_name);
            quote! { (#left_tokens) && (#right_tokens) }
        }
        GuardExpr::Or(left, right) => {
            let left_tokens = guard_check_tokens(left, all_tags, variants, tag_enum_name);
            let right_tokens = guard_check_tokens(right, all_tags, variants, tag_enum_name);
            quote! { (#left_tokens) || (#right_tokens) }
        }
    }
}

fn variant_for_tag<'a>(all_tags: &'a [String], variants: &'a [Ident], tag: &str) -> &'a Ident {
    let idx = all_tags
        .iter()
        .position(|candidate| candidate == tag)
        .expect("tag must exist in all_tags");
    &variants[idx]
}

fn collect_guard_tags(all_tags: &mut Vec<String>, guard: &GuardExpr) {
    match guard {
        GuardExpr::True => {}
        GuardExpr::Ancestor(tag) | GuardExpr::Parent(tag) => push_tag(all_tags, &tag.value()),
        GuardExpr::Not(inner) => collect_guard_tags(all_tags, inner),
        GuardExpr::And(left, right) | GuardExpr::Or(left, right) => {
            collect_guard_tags(all_tags, left);
            collect_guard_tags(all_tags, right);
        }
    }
}

fn push_tag(tags: &mut Vec<String>, tag: &str) {
    if !tags.iter().any(|value| value == tag) {
        tags.push(tag.to_string());
    }
}

fn tag_to_variant(tag: &str) -> String {
    let mut out = String::new();
    let mut capitalize = true;
    for ch in tag.chars() {
        if ch.is_ascii_alphanumeric() {
            if capitalize {
                out.push(ch.to_ascii_uppercase());
                capitalize = false;
            } else {
                out.push(ch.to_ascii_lowercase());
            }
        } else {
            capitalize = true;
        }
    }
    if out.is_empty() {
        "Tag".to_string()
    } else if out.chars().next().is_some_and(|c| c.is_ascii_digit()) {
        format!("Tag{out}")
    } else {
        out
    }
}

fn expect_ident(input: ParseStream<'_>, expected: &str) -> Result<()> {
    let ident: Ident = input.parse()?;
    if ident == expected {
        Ok(())
    } else {
        Err(Error::new(
            ident.span(),
            format!("expected `{expected}`"),
        ))
    }
}

fn peek_ident(input: ParseStream<'_>, expected: &str) -> bool {
    let fork = input.fork();
    if let Ok(ident) = fork.parse::<Ident>() {
        ident == expected
    } else {
        false
    }
}
