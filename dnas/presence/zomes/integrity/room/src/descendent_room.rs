use hdi::prelude::*;

#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct DescendentRoom {
    pub network_seed_appendix: String,
    pub name: String,
    pub icon_src: Option<String>,
    pub meta_data: Option<String>,
}
pub fn validate_create_descendent_room(
    _action: EntryCreationAction,
    _descendent_room: DescendentRoom,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_update_descendent_room(
    _action: Update,
    _descendent_room: DescendentRoom,
    _original_action: EntryCreationAction,
    _original_descendent_room: DescendentRoom,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(
        "Updating a DescendentRoom entry is not allowed.".into(),
    ))
}
pub fn validate_delete_descendent_room(
    _action: Delete,
    _original_action: EntryCreationAction,
    _original_descendent_room: DescendentRoom,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(String::from(
        "Room Infos cannot be deleted",
    )))
}
