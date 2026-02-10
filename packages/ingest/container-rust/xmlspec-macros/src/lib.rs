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
    root_tags: Vec<LitStr>,
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
    Text {
        selector: SelectorSpec,
        except: Vec<SelectorSpec>,
    },
    RootTagName,
    AttrRoot(LitStr),
    AttrAt(SelectorSpec, LitStr),
}

#[derive(Clone)]
enum SelectorSpec {
    Desc(LitStr),
    Child(LitStr),
}

#[derive(Clone)]
enum GuardExpr {
    True,
    Ancestor(LitStr),
    Parent(LitStr),
    AttrEq(LitStr, LitStr),
    FirstTextContains(SelectorSpec, LitStr),
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

        let root_tags = parse_tag_call(input)?;
        if root_tags.is_empty() {
            return Err(Error::new(
                name.span(),
                "tag(...) requires at least one tag name",
            ));
        }

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
            root_tags,
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

fn parse_tag_call(input: ParseStream<'_>) -> Result<Vec<LitStr>> {
    let fn_name: Ident = input.parse()?;
    if fn_name != "tag" {
        return Err(Error::new(fn_name.span(), "expected tag(\"...\", ...)"));
    }
    let inner;
    parenthesized!(inner in input);
    let mut tags = Vec::new();
    while !inner.is_empty() {
        tags.push(inner.parse()?);
        if inner.peek(Token![,]) {
            inner.parse::<Token![,]>()?;
        } else {
            break;
        }
    }
    Ok(tags)
}

fn parse_extractor(input: ParseStream<'_>) -> Result<ExtractorSpec> {
    let name: Ident = input.parse()?;
    let inner;
    parenthesized!(inner in input);
    match name.to_string().as_str() {
        "first_text" => Ok(ExtractorSpec::FirstText(parse_selector(&inner)?)),
        "all_text" => Ok(ExtractorSpec::AllText(parse_selector(&inner)?)),
        "text" => parse_text_extractor(&inner),
        "attr" => parse_attr_extractor(&inner),
        "root_tag_name" => parse_root_tag_name_extractor(&inner),
        _ => Err(Error::new(
            name.span(),
            "expected first_text(...), all_text(...), text(...), root_tag_name(), or attr(\"...\")",
        )),
    }
}

fn parse_root_tag_name_extractor(input: ParseStream<'_>) -> Result<ExtractorSpec> {
    if !input.is_empty() {
        return Err(Error::new(
            input.span(),
            "root_tag_name() does not take any arguments",
        ));
    }
    Ok(ExtractorSpec::RootTagName)
}

fn parse_attr_extractor(input: ParseStream<'_>) -> Result<ExtractorSpec> {
    if input.peek(LitStr) {
        return Ok(ExtractorSpec::AttrRoot(input.parse()?));
    }

    let selector = parse_selector(input)?;
    input.parse::<Token![,]>()?;
    let attr = input.parse::<LitStr>()?;

    if !input.is_empty() {
        return Err(Error::new(
            input.span(),
            "unexpected tokens in attr(...); expected attr(\"...\") or attr(selector(\"...\"), \"...\")",
        ));
    }

    Ok(ExtractorSpec::AttrAt(selector, attr))
}

fn parse_text_extractor(input: ParseStream<'_>) -> Result<ExtractorSpec> {
    let selector = parse_selector(input)?;
    let mut except = Vec::new();

    if input.peek(Token![,]) {
        input.parse::<Token![,]>()?;
        let except_ident: Ident = input.parse()?;
        if except_ident != "except" {
            return Err(Error::new(
                except_ident.span(),
                "expected except(...) as second argument to text(...)",
            ));
        }
        let except_inner;
        parenthesized!(except_inner in input);
        while !except_inner.is_empty() {
            except.push(parse_selector(&except_inner)?);
            if except_inner.peek(Token![,]) {
                except_inner.parse::<Token![,]>()?;
            } else {
                break;
            }
        }
    }

    if !input.is_empty() {
        return Err(Error::new(
            input.span(),
            "unexpected tokens in text(...) extractor",
        ));
    }

    Ok(ExtractorSpec::Text { selector, except })
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
        "attr" => {
            let inner;
            parenthesized!(inner in input);
            let attr_name: LitStr = inner.parse()?;
            input.parse::<Token![==]>()?;
            let value: LitStr = input.parse()?;
            Ok(GuardExpr::AttrEq(attr_name, value))
        }
        "first_text" => {
            let inner;
            parenthesized!(inner in input);
            let selector = parse_selector(&inner)?;
            input.parse::<Token![~]>()?;
            input.parse::<Token![=]>()?;
            let pattern: LitStr = input.parse()?;
            Ok(GuardExpr::FirstTextContains(selector, pattern))
        }
        _ => Err(Error::new(
            ident.span(),
            "expected true, ancestor(\"...\"), parent(\"...\"), attr(\"...\")==\"...\", first_text(selector) ~= \"...\", not(...), and/or",
        )),
    }
}

enum DynamicGuardField {
    AttrEq {
        ident: Ident,
        attr_name: LitStr,
        expected: LitStr,
    },
    FirstTextContains {
        ident: Ident,
        selector: SelectorSpec,
    },
}

fn guard_has_static_predicates(guard: &GuardExpr) -> bool {
    match guard {
        GuardExpr::True => false,
        GuardExpr::Ancestor(_) | GuardExpr::Parent(_) => true,
        GuardExpr::AttrEq(_, _) | GuardExpr::FirstTextContains(_, _) => false,
        GuardExpr::Not(inner) => guard_has_static_predicates(inner),
        GuardExpr::And(left, right) | GuardExpr::Or(left, right) => {
            guard_has_static_predicates(left) || guard_has_static_predicates(right)
        }
    }
}

fn guard_has_dynamic_predicates(guard: &GuardExpr) -> bool {
    match guard {
        GuardExpr::True | GuardExpr::Ancestor(_) | GuardExpr::Parent(_) => false,
        GuardExpr::AttrEq(_, _) | GuardExpr::FirstTextContains(_, _) => true,
        GuardExpr::Not(inner) => guard_has_dynamic_predicates(inner),
        GuardExpr::And(left, right) | GuardExpr::Or(left, right) => {
            guard_has_dynamic_predicates(left) || guard_has_dynamic_predicates(right)
        }
    }
}

fn collect_dynamic_guard_fields(
    guard: &GuardExpr,
    fields: &mut Vec<DynamicGuardField>,
) {
    match guard {
        GuardExpr::True | GuardExpr::Ancestor(_) | GuardExpr::Parent(_) => {}
        GuardExpr::AttrEq(attr_name, expected) => {
            let ident = format_ident!("__guard_attr_eq_{}", fields.len());
            fields.push(DynamicGuardField::AttrEq {
                ident,
                attr_name: attr_name.clone(),
                expected: expected.clone(),
            });
        }
        GuardExpr::FirstTextContains(selector, _) => {
            let ident = format_ident!("__guard_first_text_{}", fields.len());
            fields.push(DynamicGuardField::FirstTextContains {
                ident,
                selector: selector.clone(),
            });
        }
        GuardExpr::Not(inner) => collect_dynamic_guard_fields(inner, fields),
        GuardExpr::And(left, right) | GuardExpr::Or(left, right) => {
            collect_dynamic_guard_fields(left, fields);
            collect_dynamic_guard_fields(right, fields);
        }
    }
}

fn expand_xmlspec(spec: XmlSpecInput) -> Result<proc_macro2::TokenStream> {
    let schema_name = spec.schema_name;
    let tag_enum_name = format_ident!("{}Tag", schema_name);
    let scope_enum_name = format_ident!("{}Scope", schema_name);
    let output_enum_name = format_ident!("{}Output", schema_name);
    let mut record_dynamic_fields = Vec::<Vec<DynamicGuardField>>::new();

    let mut all_tags = Vec::<String>::new();
    for record in &spec.records {
        if guard_has_static_predicates(&record.guard) && guard_has_dynamic_predicates(&record.guard)
        {
            return Err(Error::new(
                record.name.span(),
                "where clauses cannot mix ancestor/parent predicates with attr(...)==... or first_text(...)~=... predicates",
            ));
        }
        let mut dynamic_fields = Vec::new();
        collect_dynamic_guard_fields(&record.guard, &mut dynamic_fields);
        record_dynamic_fields.push(dynamic_fields);

        for root_tag in &record.root_tags {
            push_tag(&mut all_tags, &root_tag.value());
        }
        collect_guard_tags(&mut all_tags, &record.guard);
        for field in &record.fields {
            match &field.extractor {
                ExtractorSpec::FirstText(selector) | ExtractorSpec::AllText(selector) => {
                    let tag = match selector {
                        SelectorSpec::Desc(tag) | SelectorSpec::Child(tag) => tag.value(),
                    };
                    push_tag(&mut all_tags, &tag);
                }
                ExtractorSpec::Text { selector, except } => {
                    let tag = match selector {
                        SelectorSpec::Desc(tag) | SelectorSpec::Child(tag) => tag.value(),
                    };
                    push_tag(&mut all_tags, &tag);
                    for selector in except {
                        let except_tag = match selector {
                            SelectorSpec::Desc(tag) | SelectorSpec::Child(tag) => tag.value(),
                        };
                        push_tag(&mut all_tags, &except_tag);
                    }
                }
                ExtractorSpec::RootTagName => {}
                ExtractorSpec::AttrRoot(_) => {}
                ExtractorSpec::AttrAt(selector, _) => {
                    let tag = match selector {
                        SelectorSpec::Desc(tag) | SelectorSpec::Child(tag) => tag.value(),
                    };
                    push_tag(&mut all_tags, &tag);
                }
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

    let mut roots = Vec::new();
    for (idx, record) in spec.records.iter().enumerate() {
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        for root_tag in &record.root_tags {
            let root_variant = variant_for_tag(&all_tags, &variants, &root_tag.value());
            roots.push(quote! {
                ::usc_ingest::xmlspec::RootSpec {
                    tag: #tag_enum_name::#root_variant,
                    guard: ::usc_ingest::xmlspec::Guard::True,
                    scope_kind: #scope_kind,
                }
            });
        }
    }

    let root_tag_name_arms = all_tags.iter().zip(variants.iter()).map(|(tag, variant)| {
        quote! { #tag_enum_name::#variant => #tag, }
    });

    let matches_root_arms = spec.records.iter().enumerate().map(|(idx, record)| {
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        let guard_check = if guard_has_dynamic_predicates(&record.guard) {
            quote! { true }
        } else {
            start_guard_check_tokens(&record.guard, &all_tags, &variants, &tag_enum_name)
        };
        quote! {
            #scope_kind => #guard_check,
        }
    });

    let scope_variants = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        quote! { #state_name(#state_name) }
    });

    let state_structs = spec
        .records
        .iter()
        .zip(record_dynamic_fields.iter())
        .map(|(record, dynamic_fields)| {
        let state_name = format_ident!("{}State", record.name);
        let reducers = record.fields.iter().map(|field| {
            let field_name = &field.name;
            let ty = reducer_type_tokens(&field.extractor, &tag_enum_name);
            quote! { #field_name: #ty }
        });
        let guard_fields = dynamic_fields.iter().map(|field| match field {
            DynamicGuardField::AttrEq { ident, .. } => quote! { #ident: bool },
            DynamicGuardField::FirstTextContains { ident, .. } => {
                quote! { #ident: ::usc_ingest::xmlspec::FirstTextReducer<#tag_enum_name> }
            }
        });
        quote! {
            pub struct #state_name {
                #(#reducers,)*
                #(#guard_fields,)*
                __root_depth: u32,
            }
        }
    });

    let open_scope_arms = spec
        .records
        .iter()
        .zip(record_dynamic_fields.iter())
        .enumerate()
        .map(|(idx, (record, dynamic_fields))| {
        let state_name = format_ident!("{}State", record.name);
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        let field_inits = record.fields.iter().map(|field| {
            let field_name = &field.name;
            let init = reducer_init_tokens(&field.extractor, &all_tags, &variants, &tag_enum_name);
            quote! { #field_name: #init }
        });
        let guard_inits = dynamic_fields.iter().map(|field| match field {
            DynamicGuardField::AttrEq {
                ident,
                attr_name,
                expected,
            } => {
                let attr_bytes = LitByteStr::new(attr_name.value().as_bytes(), attr_name.span());
                let expected_value = expected.value();
                quote! {
                    #ident: start
                        .attributes()
                        .flatten()
                        .find(|attr| attr.key.as_ref() == #attr_bytes)
                        .map(|attr| ::std::string::String::from_utf8_lossy(attr.value.as_ref()).as_ref() == #expected_value)
                        .unwrap_or(false)
                }
            }
            DynamicGuardField::FirstTextContains {
                ident, selector, ..
            } => {
                let selector_tokens =
                    selector_tokens(selector, &all_tags, &variants, &tag_enum_name);
                quote! {
                    #ident: ::usc_ingest::xmlspec::FirstTextReducer::new(#selector_tokens, root_depth)
                }
            }
        });
        quote! {
            #scope_kind => #scope_enum_name::#state_name(#state_name {
                #(#field_inits,)*
                #(#guard_inits,)*
                __root_depth: root_depth,
            }),
        }
    });

    let on_start_arms = spec
        .records
        .iter()
        .zip(record_dynamic_fields.iter())
        .map(|(record, dynamic_fields)| {
        let state_name = format_ident!("{}State", record.name);
        let reducer_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            match &field.extractor {
                ExtractorSpec::AttrRoot(_) => quote! {},
                ExtractorSpec::RootTagName => quote! {},
                ExtractorSpec::AttrAt(selector, _) => {
                    let selector_tokens =
                        selector_tokens(selector, &all_tags, &variants, &tag_enum_name);
                    quote! {
                        if ::usc_ingest::xmlspec::selector_matches(
                            #selector_tokens,
                            state.__root_depth,
                            event.depth,
                            event.tag,
                        ) {
                            state.#field_name.capture(event.attrs);
                        }
                    }
                }
                _ => quote! { state.#field_name.on_start(event.tag, event.depth); },
            }
        });
        let guard_calls = dynamic_fields.iter().map(|field| match field {
            DynamicGuardField::AttrEq { .. } => quote! {},
            DynamicGuardField::FirstTextContains { ident, .. } => {
                quote! { state.#ident.on_start(event.tag, event.depth); }
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#reducer_calls)*
                #(#guard_calls)*
            }
        }
    });

    let on_text_arms = spec
        .records
        .iter()
        .zip(record_dynamic_fields.iter())
        .map(|(record, dynamic_fields)| {
        let state_name = format_ident!("{}State", record.name);
        let reducer_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            if matches!(
                &field.extractor,
                ExtractorSpec::AttrRoot(_) | ExtractorSpec::AttrAt(_, _) | ExtractorSpec::RootTagName
            ) {
                quote! {}
            } else {
                quote! { state.#field_name.on_text(text); }
            }
        });
        let guard_calls = dynamic_fields.iter().map(|field| match field {
            DynamicGuardField::AttrEq { .. } => quote! {},
            DynamicGuardField::FirstTextContains { ident, .. } => {
                quote! { state.#ident.on_text(text); }
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#reducer_calls)*
                #(#guard_calls)*
            }
        }
    });

    let on_end_arms = spec
        .records
        .iter()
        .zip(record_dynamic_fields.iter())
        .map(|(record, dynamic_fields)| {
        let state_name = format_ident!("{}State", record.name);
        let reducer_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            if matches!(
                &field.extractor,
                ExtractorSpec::AttrRoot(_) | ExtractorSpec::AttrAt(_, _) | ExtractorSpec::RootTagName
            ) {
                quote! {}
            } else {
                quote! { state.#field_name.on_end(event.depth); }
            }
        });
        let guard_calls = dynamic_fields.iter().map(|field| match field {
            DynamicGuardField::AttrEq { .. } => quote! {},
            DynamicGuardField::FirstTextContains { ident, .. } => {
                quote! { state.#ident.on_end(event.depth); }
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#reducer_calls)*
                #(#guard_calls)*
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

    let close_scope_arms = spec
        .records
        .iter()
        .zip(record_dynamic_fields.iter())
        .map(|(record, dynamic_fields)| {
        let record_name = &record.name;
        let state_name = format_ident!("{}State", record.name);
        let guard_check = if guard_has_dynamic_predicates(&record.guard) {
            let mut next_guard_index = 0usize;
            close_guard_check_tokens(&record.guard, dynamic_fields, &mut next_guard_index)
        } else {
            quote! { true }
        };
        let fields = record.fields.iter().map(|field| {
            let field_name = &field.name;
            match &field.extractor {
                ExtractorSpec::RootTagName => quote! { #field_name: state.#field_name },
                _ => quote! { #field_name: state.#field_name.take() },
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                if !(#guard_check) {
                    None
                } else {
                    Some(#output_enum_name::#record_name(#record_name {
                        #(#fields,)*
                    }))
                }
            },
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
                root: Self::Tag,
                start: &quick_xml::events::BytesStart<'_>,
                view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) -> Self::Scope {
                let root_depth = view.depth() + 1;
                let root_tag_name = match root {
                    #(#root_tag_name_arms)*
                };
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
        ExtractorSpec::Text { .. } => quote! { ::usc_ingest::xmlspec::TextReducer<#tag_enum_name> },
        ExtractorSpec::RootTagName => quote! { Option<String> },
        ExtractorSpec::AttrRoot(_) | ExtractorSpec::AttrAt(_, _) => {
            quote! { ::usc_ingest::xmlspec::AttrReducer }
        }
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
        ExtractorSpec::Text { selector, except } => {
            let sel = selector_tokens(selector, all_tags, variants, tag_enum_name);
            let except_tokens = except
                .iter()
                .map(|selector| selector_tokens(selector, all_tags, variants, tag_enum_name));
            quote! {
                ::usc_ingest::xmlspec::TextReducer::new(#sel, vec![#(#except_tokens),*], root_depth)
            }
        }
        ExtractorSpec::RootTagName => {
            quote! { Some(root_tag_name.to_string()) }
        }
        ExtractorSpec::AttrRoot(attr) => {
            let attr_value = attr.value();
            let attr_bytes = LitByteStr::new(attr_value.as_bytes(), attr.span());
            quote! {{
                let mut reducer = ::usc_ingest::xmlspec::AttrReducer::new(#attr_bytes);
                reducer.capture(start);
                reducer
            }}
        }
        ExtractorSpec::AttrAt(selector, attr) => {
            let _selector_tokens = selector_tokens(selector, all_tags, variants, tag_enum_name);
            let attr_value = attr.value();
            let attr_bytes = LitByteStr::new(attr_value.as_bytes(), attr.span());
            quote! {{
                ::usc_ingest::xmlspec::AttrReducer::new(#attr_bytes)
            }}
        }
    }
}

fn output_field_type_tokens(extractor: &ExtractorSpec) -> proc_macro2::TokenStream {
    match extractor {
        ExtractorSpec::FirstText(_)
        | ExtractorSpec::Text { .. }
        | ExtractorSpec::RootTagName
        | ExtractorSpec::AttrRoot(_)
        | ExtractorSpec::AttrAt(_, _) => {
            quote! { Option<String> }
        }
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

fn start_guard_check_tokens(
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
        GuardExpr::AttrEq(_, _) | GuardExpr::FirstTextContains(_, _) => quote! { true },
        GuardExpr::Not(inner) => {
            let inner_tokens = start_guard_check_tokens(inner, all_tags, variants, tag_enum_name);
            quote! { !(#inner_tokens) }
        }
        GuardExpr::And(left, right) => {
            let left_tokens = start_guard_check_tokens(left, all_tags, variants, tag_enum_name);
            let right_tokens = start_guard_check_tokens(right, all_tags, variants, tag_enum_name);
            quote! { (#left_tokens) && (#right_tokens) }
        }
        GuardExpr::Or(left, right) => {
            let left_tokens = start_guard_check_tokens(left, all_tags, variants, tag_enum_name);
            let right_tokens = start_guard_check_tokens(right, all_tags, variants, tag_enum_name);
            quote! { (#left_tokens) || (#right_tokens) }
        }
    }
}

fn close_guard_check_tokens(
    guard: &GuardExpr,
    dynamic_fields: &[DynamicGuardField],
    next_guard_index: &mut usize,
) -> proc_macro2::TokenStream {
    match guard {
        GuardExpr::True | GuardExpr::Ancestor(_) | GuardExpr::Parent(_) => quote! { true },
        GuardExpr::AttrEq(_, _) => {
            let field = dynamic_fields
                .get(*next_guard_index)
                .expect("guard field index is in range");
            *next_guard_index += 1;
            match field {
                DynamicGuardField::AttrEq { ident, .. } => quote! { state.#ident },
                DynamicGuardField::FirstTextContains { .. } => {
                    panic!("guard field type mismatch for AttrEq")
                }
            }
        }
        GuardExpr::FirstTextContains(_, pattern) => {
            let field = dynamic_fields
                .get(*next_guard_index)
                .expect("guard field index is in range");
            *next_guard_index += 1;
            let pattern_lower = pattern.value().to_ascii_lowercase();
            match field {
                DynamicGuardField::FirstTextContains { ident, .. } => quote! {
                    state.#ident
                        .peek()
                        .map(|value| value.to_ascii_lowercase().contains(#pattern_lower))
                        .unwrap_or(false)
                },
                DynamicGuardField::AttrEq { .. } => {
                    panic!("guard field type mismatch for FirstTextContains")
                }
            }
        }
        GuardExpr::Not(inner) => {
            let inner_tokens = close_guard_check_tokens(inner, dynamic_fields, next_guard_index);
            quote! { !(#inner_tokens) }
        }
        GuardExpr::And(left, right) => {
            let left_tokens = close_guard_check_tokens(left, dynamic_fields, next_guard_index);
            let right_tokens = close_guard_check_tokens(right, dynamic_fields, next_guard_index);
            quote! { (#left_tokens) && (#right_tokens) }
        }
        GuardExpr::Or(left, right) => {
            let left_tokens = close_guard_check_tokens(left, dynamic_fields, next_guard_index);
            let right_tokens = close_guard_check_tokens(right, dynamic_fields, next_guard_index);
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
        GuardExpr::True | GuardExpr::AttrEq(_, _) => {}
        GuardExpr::Ancestor(tag) | GuardExpr::Parent(tag) => push_tag(all_tags, &tag.value()),
        GuardExpr::FirstTextContains(selector, _) => {
            let tag = match selector {
                SelectorSpec::Desc(tag) | SelectorSpec::Child(tag) => tag.value(),
            };
            push_tag(all_tags, &tag);
        }
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
