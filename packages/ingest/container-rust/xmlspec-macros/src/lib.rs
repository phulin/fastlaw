use proc_macro::TokenStream;
use quote::{format_ident, quote};
use std::collections::BTreeSet;
use syn::parse::{Parse, ParseStream};
use syn::{
    braced, parenthesized, parse_macro_input, Error, Ident, LitByteStr, LitStr, Result, Token,
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
    where_selector: SelectorExpr,
    fields: Vec<FieldSpec>,
}

struct FieldSpec {
    name: Ident,
    reducer: ReducerSpec,
    selector: SelectorExpr,
    inline_rules: Vec<InlineRule>,
}

enum ReducerSpec {
    FirstText,
    AllText,
    Attr(LitStr),
    AllFragments,
}

struct InlineRule {
    selector: SelectorExpr,
    variant: Ident,
}

#[derive(Clone)]
enum SelectorExpr {
    Tag(Vec<LitStr>),
    Ancestor(Box<SelectorExpr>),
    Parent(Box<SelectorExpr>),
    HasAttr(LitStr),
    AttrIs(LitStr, LitStr),
    And(Vec<SelectorExpr>),
    Or(Vec<SelectorExpr>),
    Not(Box<SelectorExpr>),
    True,
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

        let where_selector = if input.peek(Token![where]) {
            input.parse::<Token![where]>()?;
            parse_selector_expr(input)?
        } else {
            SelectorExpr::True
        };
        validate_selector_expr(&where_selector)?;

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
            where_selector,
            fields,
        })
    }
}

impl Parse for FieldSpec {
    fn parse(input: ParseStream<'_>) -> Result<Self> {
        let name: Ident = input.parse()?;
        input.parse::<Token![:]>()?;
        let reducer = parse_reducer(input)?;

        if !input.peek(Token![where]) {
            return Err(Error::new(
                input.span(),
                "field reducers must include `where <selector>`",
            ));
        }
        input.parse::<Token![where]>()?;
        let selector = parse_selector_expr(input)?;
        validate_selector_expr(&selector)?;

        let inline_rules = if peek_ident(input, "inline") {
            if !matches!(reducer, ReducerSpec::AllFragments) {
                return Err(Error::new(
                    name.span(),
                    "inline { ... } is only valid for all_fragments() reducers",
                ));
            }
            expect_ident(input, "inline")?;
            parse_inline_rules(input)?
        } else {
            Vec::new()
        };

        if matches!(reducer, ReducerSpec::AllFragments) {
            for rule in &inline_rules {
                if !is_tag_reducible(&rule.selector) {
                    return Err(Error::new(
                        name.span(),
                        "inline rule selectors must be reducible to tag(...) checks",
                    ));
                }
            }
        }

        input.parse::<Token![,]>()?;

        Ok(Self {
            name,
            reducer,
            selector,
            inline_rules,
        })
    }
}

fn parse_reducer(input: ParseStream<'_>) -> Result<ReducerSpec> {
    let name: Ident = input.parse()?;
    let inner;
    parenthesized!(inner in input);
    match name.to_string().as_str() {
        "first_text" => {
            if !inner.is_empty() {
                return Err(Error::new(
                    inner.span(),
                    "first_text() does not take arguments",
                ));
            }
            Ok(ReducerSpec::FirstText)
        }
        "all_text" => {
            if !inner.is_empty() {
                return Err(Error::new(
                    inner.span(),
                    "all_text() does not take arguments",
                ));
            }
            Ok(ReducerSpec::AllText)
        }
        "attr" => Ok(ReducerSpec::Attr(inner.parse()?)),
        "all_fragments" => {
            if !inner.is_empty() {
                return Err(Error::new(
                    inner.span(),
                    "all_fragments() does not take arguments",
                ));
            }
            Ok(ReducerSpec::AllFragments)
        }
        _ => Err(Error::new(
            name.span(),
            "expected first_text(), all_text(), attr(\"...\"), or all_fragments()",
        )),
    }
}

fn parse_inline_rules(input: ParseStream<'_>) -> Result<Vec<InlineRule>> {
    let content;
    braced!(content in input);
    let mut rules = Vec::new();
    while !content.is_empty() {
        let selector = parse_selector_expr(&content)?;
        content.parse::<Token![=>]>()?;
        let variant: Ident = content.parse()?;
        if content.peek(Token![,]) {
            content.parse::<Token![,]>()?;
        }
        rules.push(InlineRule { selector, variant });
    }
    Ok(rules)
}

fn parse_tag_call(input: ParseStream<'_>) -> Result<Vec<LitStr>> {
    let selector = parse_selector_expr(input)?;
    match selector {
        SelectorExpr::Tag(tags) => Ok(tags),
        _ => Err(Error::new(input.span(), "from expects tag(\"...\", ...)")),
    }
}

fn parse_selector_expr(input: ParseStream<'_>) -> Result<SelectorExpr> {
    if input.peek(syn::token::Paren) {
        let inner;
        parenthesized!(inner in input);
        return parse_selector_expr(&inner);
    }
    let ident: Ident = input.parse()?;

    let args;
    parenthesized!(args in input);
    match ident.to_string().as_str() {
        "tag" => {
            let mut tags = Vec::new();
            while !args.is_empty() {
                tags.push(args.parse()?);
                if args.peek(Token![,]) {
                    args.parse::<Token![,]>()?;
                } else {
                    break;
                }
            }
            if tags.is_empty() {
                return Err(Error::new(ident.span(), "tag(...) requires at least one string"));
            }
            Ok(SelectorExpr::Tag(tags))
        }
        "ancestor" => Ok(SelectorExpr::Ancestor(Box::new(parse_selector_expr(&args)?))),
        "parent" => Ok(SelectorExpr::Parent(Box::new(parse_selector_expr(&args)?))),
        "has_attr" => Ok(SelectorExpr::HasAttr(args.parse()?)),
        "attr_is" => {
            let name: LitStr = args.parse()?;
            args.parse::<Token![,]>()?;
            let value: LitStr = args.parse()?;
            Ok(SelectorExpr::AttrIs(name, value))
        }
        "and" => {
            let items = parse_selector_list(&args)?;
            if items.len() < 2 {
                return Err(Error::new(ident.span(), "and(...) requires at least two selectors"));
            }
            Ok(SelectorExpr::And(items))
        }
        "or" => {
            let items = parse_selector_list(&args)?;
            if items.len() < 2 {
                return Err(Error::new(ident.span(), "or(...) requires at least two selectors"));
            }
            Ok(SelectorExpr::Or(items))
        }
        "not" => Ok(SelectorExpr::Not(Box::new(parse_selector_expr(&args)?))),
        "true" => {
            if !args.is_empty() {
                return Err(Error::new(ident.span(), "true() does not take arguments"));
            }
            Ok(SelectorExpr::True)
        }
        _ => Err(Error::new(
            ident.span(),
            "expected tag(...), ancestor(...), parent(...), has_attr(...), attr_is(...), and(...), or(...), not(...), or true()",
        )),
    }
}

fn parse_selector_list(input: ParseStream<'_>) -> Result<Vec<SelectorExpr>> {
    let mut out = Vec::new();
    while !input.is_empty() {
        out.push(parse_selector_expr(input)?);
        if input.peek(Token![,]) {
            input.parse::<Token![,]>()?;
        } else {
            break;
        }
    }
    Ok(out)
}

fn validate_selector_expr(selector: &SelectorExpr) -> Result<()> {
    match selector {
        SelectorExpr::Ancestor(inner) | SelectorExpr::Parent(inner) => {
            if !is_tag_reducible(inner) {
                return Err(Error::new(
                    proc_macro2::Span::call_site(),
                    "ancestor(...) and parent(...) arguments must be reducible to tag(...) checks",
                ));
            }
            validate_selector_expr(inner)?;
        }
        SelectorExpr::And(items) | SelectorExpr::Or(items) => {
            for item in items {
                validate_selector_expr(item)?;
            }
        }
        SelectorExpr::Not(inner) => validate_selector_expr(inner)?,
        SelectorExpr::Tag(_)
        | SelectorExpr::HasAttr(_)
        | SelectorExpr::AttrIs(_, _)
        | SelectorExpr::True => {}
    }
    Ok(())
}

fn is_tag_reducible(selector: &SelectorExpr) -> bool {
    match selector {
        SelectorExpr::Tag(_) => true,
        SelectorExpr::Or(items) => items.iter().all(is_tag_reducible),
        _ => false,
    }
}

fn collect_reducible_tags(selector: &SelectorExpr, out: &mut BTreeSet<String>) {
    match selector {
        SelectorExpr::Tag(tags) => {
            for tag in tags {
                out.insert(tag.value());
            }
        }
        SelectorExpr::Or(items) => {
            for item in items {
                collect_reducible_tags(item, out);
            }
        }
        _ => {}
    }
}

fn collect_selector_tags(selector: &SelectorExpr, tags: &mut Vec<String>) {
    match selector {
        SelectorExpr::Tag(values) => {
            for value in values {
                push_tag(tags, &value.value());
            }
        }
        SelectorExpr::Ancestor(inner)
        | SelectorExpr::Parent(inner)
        | SelectorExpr::Not(inner) => collect_selector_tags(inner, tags),
        SelectorExpr::And(items) | SelectorExpr::Or(items) => {
            for item in items {
                collect_selector_tags(item, tags);
            }
        }
        SelectorExpr::HasAttr(_) | SelectorExpr::AttrIs(_, _) | SelectorExpr::True => {}
    }
}

fn expand_xmlspec(spec: XmlSpecInput) -> Result<proc_macro2::TokenStream> {
    let schema_name = spec.schema_name;
    let tag_enum_name = format_ident!("{}Tag", schema_name);
    let scope_enum_name = format_ident!("{}Scope", schema_name);
    let output_enum_name = format_ident!("{}Output", schema_name);

    let mut all_tags = Vec::<String>::new();
    for record in &spec.records {
        for root_tag in &record.root_tags {
            push_tag(&mut all_tags, &root_tag.value());
        }
        collect_selector_tags(&record.where_selector, &mut all_tags);
        for field in &record.fields {
            collect_selector_tags(&field.selector, &mut all_tags);
            for rule in &field.inline_rules {
                collect_selector_tags(&rule.selector, &mut all_tags);
            }
        }
    }

    let variants = all_tags
        .iter()
        .map(|tag| format_ident!("{}", tag_to_variant(tag)))
        .collect::<Vec<_>>();
    let tag_count = variants.len();

    let mut tag_match_arms = Vec::new();
    for (tag, variant) in all_tags.iter().zip(variants.iter()) {
        let tag_bytes = LitByteStr::new(tag.as_bytes(), proc_macro2::Span::call_site());
        tag_match_arms.push(quote! { #tag_bytes => Some(#tag_enum_name::#variant), });
    }

    let mut roots = Vec::new();
    for (idx, record) in spec.records.iter().enumerate() {
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        for root_tag in &record.root_tags {
            let variant = variant_for_tag(&all_tags, &variants, &root_tag.value());
            roots.push(quote! {
                ::usc_ingest::xmlspec::RootSpec {
                    tag: #tag_enum_name::#variant,
                    guard: ::usc_ingest::xmlspec::Guard::True,
                    scope_kind: #scope_kind,
                }
            });
        }
    }

    let mut scope_variants = Vec::new();
    let mut fragment_enum_defs = Vec::new();
    let mut state_structs = Vec::new();
    let mut open_scope_arms = Vec::new();

    for (idx, record) in spec.records.iter().enumerate() {
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        let state_name = format_ident!("{}State", record.name);
        scope_variants.push(quote! { #state_name(#state_name) });

        let mut state_fields = Vec::new();
        let mut field_inits = Vec::new();
        for field in &record.fields {
            let field_name = &field.name;
            let ty =
                reducer_type_tokens(record, field, &tag_enum_name, &mut fragment_enum_defs);
            state_fields.push(quote! { #field_name: #ty });
            let init = reducer_init_tokens(field, &all_tags, &variants, &tag_enum_name);
            field_inits.push(quote! { #field_name: #init });
        }

        state_structs.push(quote! {
            pub struct #state_name {
                #(#state_fields,)*
            }
        });

        open_scope_arms.push(quote! {
            #scope_kind => #scope_enum_name::#state_name(#state_name {
                #(#field_inits,)*
            }),
        });
    }

    let matches_root_arms = spec.records.iter().enumerate().map(|(idx, record)| {
        let scope_kind: u16 = idx
            .try_into()
            .expect("xmlspec supports at most u16::MAX records");
        let selector_tokens = selector_eval_tokens(
            &record.where_selector,
            quote! { root.tag },
            quote! { start },
            quote! { view },
            quote! { __depth },
            &all_tags,
            &variants,
            &tag_enum_name,
        )?;
        Ok::<_, Error>(quote! {
            #scope_kind => #selector_tokens,
        })
    }).collect::<Result<Vec<_>>>()?;

    let on_start_arms = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let field_calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            let selector_tokens = selector_eval_tokens(
                &field.selector,
                quote! { event.tag },
                quote! { event.attrs },
                quote! { _view },
                quote! { event.depth },
                &all_tags,
                &variants,
                &tag_enum_name,
            )?;

            let call = match &field.reducer {
                ReducerSpec::FirstText => {
                    quote! { state.#field_name.on_start(__matches, event.depth); }
                }
                ReducerSpec::AllText => {
                    quote! { state.#field_name.on_start(__matches, event.depth); }
                }
                ReducerSpec::Attr(_) => {
                    quote! {
                        if __matches {
                            state.#field_name.capture(event.attrs);
                        }
                    }
                }
                ReducerSpec::AllFragments => {
                    quote! {
                        let __inline_kind = state.#field_name.inline_kind_for_tag(event.tag);
                        state.#field_name.on_start(__matches, event.depth, __inline_kind);
                    }
                }
            };

            Ok::<_, Error>(quote! {
                {
                    let __matches = #selector_tokens;
                    #call
                }
            })
        }).collect::<Result<Vec<_>>>()?;

        Ok::<_, Error>(quote! {
            #scope_enum_name::#state_name(state) => {
                #(#field_calls)*
            }
        })
    }).collect::<Result<Vec<_>>>()?;

    let on_text_arms = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            match field.reducer {
                ReducerSpec::FirstText | ReducerSpec::AllText | ReducerSpec::AllFragments => {
                    quote! { state.#field_name.on_text(text); }
                }
                ReducerSpec::Attr(_) => quote! {},
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#calls)*
            }
        }
    });

    let on_end_arms = spec.records.iter().map(|record| {
        let state_name = format_ident!("{}State", record.name);
        let calls = record.fields.iter().map(|field| {
            let field_name = &field.name;
            match field.reducer {
                ReducerSpec::FirstText | ReducerSpec::AllText | ReducerSpec::AllFragments => {
                    quote! { state.#field_name.on_end(event.depth); }
                }
                ReducerSpec::Attr(_) => quote! {},
            }
        });
        quote! {
            #scope_enum_name::#state_name(state) => {
                #(#calls)*
            }
        }
    });

    let mut output_enum_variants = Vec::new();
    let mut output_structs = Vec::new();
    let mut close_scope_arms = Vec::new();
    for record in &spec.records {
        let record_name = &record.name;
        output_enum_variants.push(quote! { #record_name(#record_name) });

        let mut output_fields = Vec::new();
        for field in &record.fields {
            let field_name = &field.name;
            let ty = output_field_type_tokens(record, field);
            output_fields.push(quote! { pub #field_name: #ty });
        }
        output_structs.push(quote! {
            #[derive(Debug, Clone, PartialEq, Eq)]
            pub struct #record_name {
                #(#output_fields,)*
            }
        });

        let state_name = format_ident!("{}State", record.name);
        let fields = record.fields.iter().map(|field| {
            let field_name = &field.name;
            match &field.reducer {
                ReducerSpec::FirstText | ReducerSpec::AllText | ReducerSpec::Attr(_) => {
                    quote! { #field_name: state.#field_name.take() }
                }
                ReducerSpec::AllFragments => {
                    let fragment_enum_name = fragment_enum_name(&record.name, &field.name);
                    let variant_names = field
                        .inline_rules
                        .iter()
                        .map(|rule| &rule.variant)
                        .collect::<Vec<_>>();
                    let variant_arms = variant_names.iter().enumerate().map(|(idx, variant)| {
                        let kind = idx as u16;
                        quote! { #kind => #fragment_enum_name::#variant(text), }
                    });
                    quote! {
                        #field_name: state
                            .#field_name
                            .take()
                            .into_iter()
                            .map(|fragment| match fragment {
                                ::usc_ingest::xmlspec::FragmentChunk::Text(text) => #fragment_enum_name::Text(text),
                                ::usc_ingest::xmlspec::FragmentChunk::Styled(kind, text) => match kind {
                                    #(#variant_arms)*
                                    _ => panic!("unknown inline fragment kind"),
                                },
                            })
                            .collect()
                    }
                }
            }
        });
        close_scope_arms.push(quote! {
            #scope_enum_name::#state_name(state) => {
                Some(#output_enum_name::#record_name(#record_name {
                    #(#fields,)*
                }))
            },
        });
    }

    let tag_indices = variants
        .iter()
        .enumerate()
        .map(|(idx, variant)| quote! { #tag_enum_name::#variant => #idx, })
        .collect::<Vec<_>>();

    Ok(quote! {
        #[derive(Debug, Clone, Copy, PartialEq, Eq)]
        pub enum #tag_enum_name {
            #(#variants,)*
        }

        #(#fragment_enum_defs)*
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
                start: &quick_xml::events::BytesStart<'_>,
                view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) -> bool {
                let __depth = view.depth() + 1;
                match root.scope_kind {
                    #(#matches_root_arms)*
                    _ => false,
                }
            }

            fn open_scope(
                scope_kind: u16,
                _root: Self::Tag,
                _start: &quick_xml::events::BytesStart<'_>,
                _view: &::usc_ingest::xmlspec::EngineView<'_, Self::Tag>,
            ) -> Self::Scope {
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

fn selector_eval_tokens(
    selector: &SelectorExpr,
    current_tag: proc_macro2::TokenStream,
    current_attrs: proc_macro2::TokenStream,
    view: proc_macro2::TokenStream,
    depth: proc_macro2::TokenStream,
    all_tags: &[String],
    variants: &[Ident],
    tag_enum_name: &Ident,
) -> Result<proc_macro2::TokenStream> {
    Ok(match selector {
        SelectorExpr::Tag(tags) => {
            let checks = tags.iter().map(|tag| {
                let variant = variant_for_tag(all_tags, variants, &tag.value());
                quote! { #current_tag == #tag_enum_name::#variant }
            });
            quote! { false #(|| #checks)* }
        }
        SelectorExpr::HasAttr(name) => {
            let bytes = LitByteStr::new(name.value().as_bytes(), name.span());
            quote! {
                #current_attrs
                    .attributes()
                    .flatten()
                    .any(|attr| attr.key.as_ref() == #bytes)
            }
        }
        SelectorExpr::AttrIs(name, value) => {
            let name_bytes = LitByteStr::new(name.value().as_bytes(), name.span());
            let expected = value.value();
            quote! {
                #current_attrs
                    .attributes()
                    .flatten()
                    .any(|attr| {
                        attr.key.as_ref() == #name_bytes
                            && ::std::string::String::from_utf8_lossy(attr.value.as_ref()).as_ref() == #expected
                    })
            }
        }
        SelectorExpr::And(items) => {
            let parts = items.iter().map(|item| {
                selector_eval_tokens(
                    item,
                    current_tag.clone(),
                    current_attrs.clone(),
                    view.clone(),
                    depth.clone(),
                    all_tags,
                    variants,
                    tag_enum_name,
                )
            }).collect::<Result<Vec<_>>>()?;
            quote! { true #(&& (#parts))* }
        }
        SelectorExpr::Or(items) => {
            let parts = items.iter().map(|item| {
                selector_eval_tokens(
                    item,
                    current_tag.clone(),
                    current_attrs.clone(),
                    view.clone(),
                    depth.clone(),
                    all_tags,
                    variants,
                    tag_enum_name,
                )
            }).collect::<Result<Vec<_>>>()?;
            quote! { false #(|| (#parts))* }
        }
        SelectorExpr::Not(inner) => {
            let tokens = selector_eval_tokens(
                inner,
                current_tag,
                current_attrs,
                view,
                depth,
                all_tags,
                variants,
                tag_enum_name,
            )?;
            quote! { !(#tokens) }
        }
        SelectorExpr::Ancestor(inner) => {
            let mut tags = BTreeSet::new();
            collect_reducible_tags(inner, &mut tags);
            let checks = tags.iter().map(|tag| {
                let variant = variant_for_tag(all_tags, variants, tag);
                quote! { #view.ancestor_of_depth(#tag_enum_name::#variant, #depth) }
            });
            quote! { false #(|| #checks)* }
        }
        SelectorExpr::Parent(inner) => {
            let mut tags = BTreeSet::new();
            collect_reducible_tags(inner, &mut tags);
            let checks = tags.iter().map(|tag| {
                let variant = variant_for_tag(all_tags, variants, tag);
                quote! { #view.parent_of_depth(#tag_enum_name::#variant, #depth) }
            });
            quote! { false #(|| #checks)* }
        }
        SelectorExpr::True => quote! { true },
    })
}

fn reducer_type_tokens(
    record: &RecordSpec,
    field: &FieldSpec,
    tag_enum_name: &Ident,
    fragment_defs: &mut Vec<proc_macro2::TokenStream>,
) -> proc_macro2::TokenStream {
    match field.reducer {
        ReducerSpec::FirstText => quote! { ::usc_ingest::xmlspec::FirstTextReducer },
        ReducerSpec::AllText => quote! { ::usc_ingest::xmlspec::AllTextReducer },
        ReducerSpec::Attr(_) => quote! { ::usc_ingest::xmlspec::AttrReducer },
        ReducerSpec::AllFragments => {
            let enum_name = fragment_enum_name(&record.name, &field.name);
            let variants = field
                .inline_rules
                .iter()
                .map(|rule| &rule.variant)
                .collect::<Vec<_>>();
            let def = quote! {
                #[derive(Debug, Clone, PartialEq, Eq)]
                pub enum #enum_name {
                    Text(String),
                    #(#variants(String),)*
                }
            };
            if !fragment_defs.iter().any(|existing| existing.to_string() == def.to_string()) {
                fragment_defs.push(def);
            }
            quote! { ::usc_ingest::xmlspec::AllFragmentsReducer<#tag_enum_name> }
        }
    }
}

fn reducer_init_tokens(
    field: &FieldSpec,
    all_tags: &[String],
    variants: &[Ident],
    tag_enum_name: &Ident,
) -> proc_macro2::TokenStream {
    match &field.reducer {
        ReducerSpec::FirstText => quote! { ::usc_ingest::xmlspec::FirstTextReducer::new() },
        ReducerSpec::AllText => quote! { ::usc_ingest::xmlspec::AllTextReducer::new() },
        ReducerSpec::Attr(name) => {
            let bytes = LitByteStr::new(name.value().as_bytes(), name.span());
            quote! { ::usc_ingest::xmlspec::AttrReducer::new(#bytes) }
        }
        ReducerSpec::AllFragments => {
            let mut entries = Vec::new();
            for (idx, rule) in field.inline_rules.iter().enumerate() {
                let mut tag_names = BTreeSet::new();
                collect_reducible_tags(&rule.selector, &mut tag_names);
                for tag_name in tag_names {
                    let variant = variant_for_tag(all_tags, variants, &tag_name);
                    let kind = idx as u16;
                    entries.push(quote! { (#tag_enum_name::#variant, #kind) });
                }
            }
            quote! {
                ::usc_ingest::xmlspec::AllFragmentsReducer::new(vec![#(#entries),*])
            }
        }
    }
}

fn output_field_type_tokens(record: &RecordSpec, field: &FieldSpec) -> proc_macro2::TokenStream {
    match field.reducer {
        ReducerSpec::FirstText | ReducerSpec::Attr(_) => quote! { Option<String> },
        ReducerSpec::AllText => quote! { Vec<String> },
        ReducerSpec::AllFragments => {
            let enum_name = fragment_enum_name(&record.name, &field.name);
            quote! { Vec<#enum_name> }
        }
    }
}

fn fragment_enum_name(record_name: &Ident, field_name: &Ident) -> Ident {
    format_ident!("{}{}Fragment", record_name, field_name)
}

fn variant_for_tag<'a>(all_tags: &'a [String], variants: &'a [Ident], tag: &str) -> &'a Ident {
    let idx = all_tags
        .iter()
        .position(|candidate| candidate == tag)
        .expect("tag must exist in all_tags");
    &variants[idx]
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
