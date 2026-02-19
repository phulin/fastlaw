instruction -> preceding parent amended_by:? " " ( resolution | "is" " further":? " amended" ( " " text_location ):? "—\n" subinstructions ) ".":?
preceding -> ( subsection_or_sub " " ):? ( [A-Z0-9 .-;(),]:+ ".—" ):?

parent -> initial_locator ( " of " underlying ):? ( " (" codification ")" ")":? ):?
initial_locator -> "Section " section_or_sub
  | sub_location_or_sub_caps ( " of section " section_or_sub ):?
  | "The " act " Act" ( " (" codification ")" ")":? ):?
  | "The " ( ordinal | "last" ) " sentence of section " section_or_sub
  | "The heading for section " section_or_sub
  | "The heading of section " section_or_sub
underlying -> act commonly_known:?
  | "title " [0-9]:+ ", United States Code,"
  | "the Internal Revenue Code of 1986"
  | "such Code"
  | pub_law_ref
commonly_known -> " (commonly known as the “" act "”)"
amended_by -> ", " amended_by_spec "," | " (" amended_by_spec ")"
amended_by_spec -> "as amended by " amended_by_source
  | "as added by section " section_or_sub " of " pub_law_ref
  | "as redesignated by " ( sub_location_or_sub | "section " section_or_sub )
amended_by_source -> "this section"
  | "this Act"
  | "the preceding provision" "s":? " of this Act"
  | "section " amended_by_section
  | "sections " amended_by_section " and " amended_by_section
  | "sections " amended_by_section ( ", " amended_by_section ):+ ", and " amended_by_section
  | sub_location_or_sub
amended_by_section -> section_or_sub ( " of " pub_law_ref ):?

subinstructions -> subinstruction | ( subinstruction sep "\n" ):* subinstruction sep " and":? "\n" subinstruction
subinstruction -> sub_head ( ",":? " " resolution_or_edit | "—\n" subinstructions )
  | sub_id " " ( ( subscope | subscope_plural ) ", " ):? edits
sub_head -> sub_id
  | sub_id " " subscope
  | sub_id " " subscope ", " text_location
  | sub_id " " text_location
subscope -> "in " sub_location_or_sub ( " of " sub_location_or_sub ):? sub_amended_by:?
subscope_plural -> "in ":? sub_name_plural " " sub_location_list
sep -> [,;]

sub_amended_by -> ", " sub_amended_by_spec ",":? | " (" sub_amended_by_spec ")"
sub_amended_by_spec -> "as" " so":? (" amended" | " designated" | " redesignated")
  | ( "as amended by " | "as inserted by " | "as redesignated by " ) ( section_or_sub | sub_location_or_sub ) sub_amended_container:?
sub_amended_container -> " of this " ( "section" | sub_name )

act -> [A-Za-z0-9 ,]:+ | pub_law_ref
codification -> ref ("; " ref):?
ref -> usc_ref | pub_law_ref | stat_ref
usc_ref -> [0-9]:+ " U.S.C. " section_or_sub ( " note" ( " " [0-9]:+ ):? ):?
  | [0-9]:+ " USC " section_or_sub ( " note" ( " " [0-9]:+ ):? ):?
pub_law_ref -> "Public Law " [0-9]:+ [-–] [0-9]:+
stat_ref -> [0-9]:+ " Stat. " [0-9]:+

resolution -> amendment_spec ( ",":? " " text_location ):? ",":? " " edits
resolution_or_edit -> resolution | edit
amendment_spec -> "is amended" | "is further amended"
text_location -> "in the " ordinal " sentence" text_location_anchor:?
  | "in the last sentence" text_location_anchor:?
  | "in the heading" text_location_anchor:?
  | "in the " sub_name " heading" text_location_anchor:?
  | "in the matter " ( "preceding " | "following " ) sub_location sub_amended_by:?
  | "in " ( sub_name_plural " " sub_location_list | sub_location_or_sub ) text_location_anchor:? sub_amended_by:?
  | ( "before " | "after " ) inner_location
text_location_anchor -> " thereof" | " of " sub_location_or_sub
ordinal -> "first" | "second" | "third" | "fourth" | "fifth" | "sixth" | "seventh" | "eighth" | "ninth" | "tenth"
edits -> edit
  | edit " and " edit
  | edit ( ", " edit ):* ", and " edit
  | "by " by_edit " and " by_edit
edit -> "to read as follows:" [\n ] ( block | inline ) | "by " by_edit
by_edit -> "striking " striking_spec ( " and inserting" inserting_spec ):?
  | "amending " sub_location_or_sub " to read as follows:" [ \n] block
  | "adding after " sub_location_or_sub inserting_spec
  | "adding at the end the following" new_things:? ":" [ \n]:? block
  | "adding " inline " at the end" ( " of " sub_location_or_sub ):?
  | "inserting " ( "after " | "before " ) after_before_target ",":? " the following" ( " new " ( "section" | sub_name | sub_name_plural ) ):? ":" [ \n]:? block
  | "inserting " inline ( " after " | " before " ) after_before_search ( " each place it appears" ):?
  | "inserting " inline " at the end of " sub_location_or_sub
  | "redesignating " sub_location_or_plural ( ", " amended_by_spec ):? ",":? " as " sub_location_or_plural ( ",":? " respectively"):? ( ",":? " and indenting appropriately" ):?
  | "moving such sections " ( "before " | "after ") sub_location

after_before_target -> section_location_or_sub " (as so redesignated)":?  | inner_location
after_before_search -> inline
  | inner_location
  | inline " in " inner_location

striking_spec -> striking_target following_spec:?
striking_target -> inner_location
  | "the item relating to section " section_or_sub
  | "all that precedes " sub_location_or_sub
  | striking_search
  | sub_location_or_plural
  | sub_location_or_sub

inner_location -> ( "the period" | "the semicolon" | "the comma" ) ( " at the end" ( " of " sub_location_or_sub ):? ):?
  | "the heading"
  | "the subsection heading"
  | "the section designation"
  | "the " ordinal " sentence"
  | "the last sentence"

striking_search -> inline appearances:? striking_location:?
appearances -> " in":? ( " each place it appears" | " both places it appears" )
striking_location -> " " text_location | " at the end" ( " of " sub_location_or_sub ):?
following_spec -> " and all that follows" through_spec:?
through_spec -> " through the period" ( " at the end" ( " of " sub_location):? ):?
  | " through the end of " sub_location
  | " through " inline
inserting_spec -> " " inserting_space | ":":? [\n ] block
inserting_space -> "a period" | "a comma" | "a semicolon" | inline | block | "the following" new_things:? ":" [\n ] ( inline | block )

new_things -> " new " ( "section" "s":? | sub_name | sub_name_plural | "sentence" | "flush sentence" )

section_location_or_sub -> "section " section_or_sub | sub_location_or_sub

sub_location_or_sub -> sub_name " " subsection_or_sub
sub_location_or_sub_caps -> sub_name_caps " " subsection_or_sub

section_or_sub -> section_id " ":? subsection_or_sub:?
section_id -> [0-9]:+ [A-Za-z0-9–-]:*
subsection_or_sub -> sub_id:+

sub_location_list -> sub_id " and " sub_id
  | sub_id ( ", " sub_id ):+ ", and " sub_id

sub_location_or_plural -> ( sub_location | sub_locations_plural ) ( " of " sub_location ):?
sub_location -> sub_name " " sub_id

sub_locations_plural -> sub_name_plural " " sub_id " and " sub_id
  | sub_name_plural " " sub_id ( ", " sub_id ):* ", and " sub_id
  | sub_name_plural " " sub_id " through " sub_id

sub_name -> "subsection" | "paragraph" | "subparagraph" | "clause" | "subclause" | "item" | "subitem"
sub_name_plural -> "subsections" | "paragraphs" | "subparagraphs" | "clauses" | "subclauses" | "items" | "subitems"
sub_name_caps -> "Subsection" | "Paragraph" | "Subparagraph" | "Clause" | "Subclause" | "Item" | "Subitem"

text -> [a-zA-Z0-9 ()-–—.,;:‘’$&/\u2044]:+
inline -> "“" text "”"
block -> block_line ("\n" block_line):*
block_line -> "“" text "”" | text "”" | "“" text

sub_id -> lower_id | upper_id | digit_id

lower_id -> "(" [a-z]:+ ")"
upper_id -> "(" [A-Z]:+ ")"
digit_id -> "(" [0-9]:+ ")"
