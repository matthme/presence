use hdi::prelude::*;
pub fn validate_create_link_anchor_to_agent(
    action: CreateLink,
    base_address: AnyLinkableHash,
    target_address: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    // Validate that the link target is a punlic key
    let target_pubkey = match AgentPubKey::try_from(action.target_address.clone()) {
        Ok(pubkey) => pubkey,
        Err(_) => {
            return Ok(ValidateCallbackResult::Invalid(
                "AnchorToAgent link target is not an agent public key.".into(),
            ))
        }
    };
    debug!(
        "action.author: {:?}\ntarget_pubkey: {:?}\naction.target_address: {:?}\ntarget_address: {:?}\nbase_address: {:?}",
        action.author, target_pubkey, action.target_address, target_address, base_address
    );
    // Validate that the author of the Create action matches the link target
    if action.author != target_pubkey {
        return Ok(ValidateCallbackResult::Invalid(
            "Links from the ALL_AGENTS anchor can only be created for oneself.".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_delete_link_anchor_to_agent(
    action: DeleteLink,
    _original_action: CreateLink,
    _base: AnyLinkableHash,
    target: AnyLinkableHash,
    _tag: LinkTag,
) -> ExternResult<ValidateCallbackResult> {
    // Validate that the link target is a public key
    let target_pubkey = match AgentPubKey::try_from(target) {
        Ok(pubkey) => pubkey,
        Err(_) => {
            return Ok(ValidateCallbackResult::Invalid(
                "AnchorToAgent link target is not an agent public key.".into(),
            ))
        }
    };
    // Validate that the author of the Delete action matches the link target as well as the original_action
    if action.author != target_pubkey {
        return Ok(ValidateCallbackResult::Invalid(
            "Only own links from the ALL_AGENTS anchor can be deleted.".into(),
        ));
    }
    Ok(ValidateCallbackResult::Valid)
}
