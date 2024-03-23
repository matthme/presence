pub mod anchor_to_agent;
pub use anchor_to_agent::*;
use hdi::prelude::*;
#[derive(Serialize, Deserialize)]
#[hdk_link_types]
pub enum LinkTypes {
    AnchorToAgent,
    AgentAnchor,
}
#[hdk_extern]
pub fn genesis_self_check(_data: GenesisSelfCheckData) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
pub fn validate_agent_joining(
    _agent_pub_key: AgentPubKey,
    _membrane_proof: &Option<MembraneProof>,
) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Valid)
}
#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<(), LinkTypes>()? {
        FlatOp::StoreEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry { app_entry, action } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            OpEntry::UpdateEntry {
                app_entry, action, ..
            } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterUpdate(update_entry) => match update_entry {
            OpUpdate::Entry {
                original_action,
                original_app_entry,
                app_entry,
                action,
            } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterDelete(delete_entry) => match delete_entry {
            OpDelete::Entry {
                original_action,
                original_app_entry,
                action,
            } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterCreateLink {
            link_type,
            base_address,
            target_address,
            tag,
            action,
        } => match link_type {
            LinkTypes::AnchorToAgent => {
                debug!(
                    "@FlatOp::RegisterCreateLink: base_address: {:?}\ntarget_address: {:?}",
                    base_address, target_address
                );
                validate_create_link_anchor_to_agent(action, base_address, target_address, tag)
            }
            LinkTypes::AgentAnchor => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterDeleteLink {
            link_type,
            base_address,
            target_address,
            tag,
            original_action,
            action,
        } => match link_type {
            LinkTypes::AnchorToAgent => validate_delete_link_anchor_to_agent(
                action,
                original_action,
                base_address,
                target_address,
                tag,
            ),
            LinkTypes::AgentAnchor => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::StoreRecord(store_record) => match store_record {
            OpRecord::CreateEntry { app_entry, action } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            OpRecord::UpdateEntry {
                original_action_hash,
                app_entry,
                action,
                ..
            } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            OpRecord::DeleteEntry {
                original_action_hash,
                action,
                ..
            } => Ok(ValidateCallbackResult::Invalid(
                "There are no entry types in this integrity zome".to_string(),
            )),
            OpRecord::CreateLink {
                base_address,
                target_address,
                tag,
                link_type,
                action,
            } => match link_type {
                LinkTypes::AnchorToAgent => {
                    validate_create_link_anchor_to_agent(action, base_address, target_address, tag)
                }
                LinkTypes::AgentAnchor => Ok(ValidateCallbackResult::Valid),
            },
            OpRecord::DeleteLink {
                original_action_hash,
                base_address,
                action,
            } => {
                let record = must_get_valid_record(original_action_hash)?;
                let create_link = match record.action() {
                    Action::CreateLink(create_link) => create_link.clone(),
                    _ => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "The action that a DeleteLink deletes must be a CreateLink".to_string(),
                        ));
                    }
                };
                let link_type = match LinkTypes::from_type(
                    create_link.zome_index.clone(),
                    create_link.link_type.clone(),
                )? {
                    Some(lt) => lt,
                    None => {
                        return Ok(ValidateCallbackResult::Valid);
                    }
                };
                match link_type {
                    LinkTypes::AnchorToAgent => validate_delete_link_anchor_to_agent(
                        action,
                        create_link.clone(),
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AgentAnchor => Ok(ValidateCallbackResult::Valid),
                }
            }
            OpRecord::CreatePrivateEntry { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdatePrivateEntry { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CreateCapClaim { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CreateCapGrant { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdateCapClaim { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::UpdateCapGrant { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::Dna { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::OpenChain { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::CloseChain { .. } => Ok(ValidateCallbackResult::Valid),
            OpRecord::InitZomesComplete { .. } => Ok(ValidateCallbackResult::Valid),
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterAgentActivity(agent_activity) => match agent_activity {
            OpActivity::CreateAgent { agent, action } => {
                let previous_action = must_get_action(action.prev_action)?;
                match previous_action.action() {
                        Action::AgentValidationPkg(
                            AgentValidationPkg { membrane_proof, .. },
                        ) => validate_agent_joining(agent, membrane_proof),
                        _ => {
                            Ok(
                                ValidateCallbackResult::Invalid(
                                    "The previous action for a `CreateAgent` action must be an `AgentValidationPkg`"
                                        .to_string(),
                                ),
                            )
                        }
                    }
            }
            _ => Ok(ValidateCallbackResult::Valid),
        },
    }
}
