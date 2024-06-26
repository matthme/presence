use hdi::prelude::*;

pub fn validate_create_link_all_agents(
    action: CreateLink,
    _base_address: AnyLinkableHash,
    _target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    // Validate that the link target is a punlic key
    let target_pubkey = match AgentPubKey::try_from(action.target_address.clone()) {
        Ok(pubkey) => pubkey,
        Err(_) => {
            return Ok(ValidateCallbackResult::Invalid(
                "AllAgents link target is not an agent public key.".into(),
            ))
        }
    };
    // debug!(
    //     "action.author: {:?}\ntarget_pubkey: {:?}\naction.target_address: {:?}\ntarget_address: {:?}\nbase_address: {:?}",
    //     action.author, target_pubkey, action.target_address, target_address, base_address
    // );
    // Validate that the author of the Create action matches the link target
    if action.author != target_pubkey {
        return Ok(ValidateCallbackResult::Invalid(
            "Links from the ALL_AGENTS anchor can only be created for oneself.".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_delete_link_all_agents(
    _action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(String::from(
        "AllAgent links cannot be deleted.",
    )))
}
pub fn validate_create_link_all_descendent_rooms(
    _action: CreateLink,
    _base_address: AnyLinkableHash,
    _target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    // TODO validata that the link is pointing to a DescendentRoom entry
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_delete_link_all_descendent_rooms(
    _action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    _target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    // Currently anyone is allowed to delete a link to a DescendentRoom.
    Ok(ValidateCallbackResult::Valid)
}
