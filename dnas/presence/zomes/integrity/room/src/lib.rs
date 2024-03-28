pub mod attachment;
pub use attachment::*;
pub mod room_info;
use hdi::prelude::*;
pub use room_info::*;
pub mod anchors;
pub use anchors::*;
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    RoomInfo(RoomInfo),
    Attachment(Attachment),
}
#[derive(Serialize, Deserialize)]
#[hdk_link_types]
pub enum LinkTypes {
    RoomInfoUpdates,
    AllAgents,
    AllDescendentRooms,
    AttachmentUpdates,
    AllAttachments,
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
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::StoreEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry { app_entry, action } => match app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_create_room_info(EntryCreationAction::Create(action), room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_create_attachment(EntryCreationAction::Create(action), attachment)
                }
            },
            OpEntry::UpdateEntry {
                app_entry, action, ..
            } => match app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_create_room_info(EntryCreationAction::Update(action), room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_create_attachment(EntryCreationAction::Update(action), attachment)
                }
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterUpdate(update_entry) => match update_entry {
            OpUpdate::Entry {
                original_action,
                original_app_entry,
                app_entry,
                action,
            } => match (app_entry, original_app_entry) {
                (
                    EntryTypes::Attachment(attachment),
                    EntryTypes::Attachment(original_attachment),
                ) => validate_update_attachment(
                    action,
                    attachment,
                    original_action,
                    original_attachment,
                ),
                (EntryTypes::RoomInfo(room_info), EntryTypes::RoomInfo(original_room_info)) => {
                    validate_update_room_info(
                        action,
                        room_info,
                        original_action,
                        original_room_info,
                    )
                }
                _ => Ok(ValidateCallbackResult::Invalid(
                    "Original and updated entry types must be the same".to_string(),
                )),
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterDelete(delete_entry) => match delete_entry {
            OpDelete::Entry {
                original_action,
                original_app_entry,
                action,
            } => match original_app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_delete_room_info(action, original_action, room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_delete_attachment(action, original_action, attachment)
                }
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::RegisterCreateLink {
            link_type,
            base_address,
            target_address,
            tag,
            action,
        } => match link_type {
            LinkTypes::RoomInfoUpdates => {
                validate_create_link_room_info_updates(action, base_address, target_address, tag)
            }
            LinkTypes::AllAgents => {
                validate_create_link_all_agents(action, base_address, target_address, tag)
            }
            LinkTypes::AllDescendentRooms => {
                validate_create_link_all_descendent_rooms(action, base_address, target_address, tag)
            }
            LinkTypes::AttachmentUpdates => {
                validate_create_link_attachment_updates(action, base_address, target_address, tag)
            }
            LinkTypes::AllAttachments => {
                validate_create_link_all_attachments(action, base_address, target_address, tag)
            }
        },
        FlatOp::RegisterDeleteLink {
            link_type,
            base_address,
            target_address,
            tag,
            original_action,
            action,
        } => match link_type {
            LinkTypes::RoomInfoUpdates => validate_delete_link_room_info_updates(
                action,
                original_action,
                base_address,
                target_address,
                tag,
            ),
            LinkTypes::AllAgents => validate_delete_link_all_agents(
                action,
                original_action,
                base_address,
                target_address,
                tag,
            ),
            LinkTypes::AllDescendentRooms => validate_delete_link_all_descendent_rooms(
                action,
                original_action,
                base_address,
                target_address,
                tag,
            ),
            LinkTypes::AttachmentUpdates => validate_delete_link_attachment_updates(
                action,
                original_action,
                base_address,
                target_address,
                tag,
            ),
            LinkTypes::AllAttachments => validate_delete_link_all_attachments(
                action,
                original_action,
                base_address,
                target_address,
                tag,
            ),
        },
        FlatOp::StoreRecord(store_record) => match store_record {
            OpRecord::CreateEntry { app_entry, action } => match app_entry {
                EntryTypes::RoomInfo(room_info) => {
                    validate_create_room_info(EntryCreationAction::Create(action), room_info)
                }
                EntryTypes::Attachment(attachment) => {
                    validate_create_attachment(EntryCreationAction::Create(action), attachment)
                }
            },
            OpRecord::UpdateEntry {
                original_action_hash,
                app_entry,
                action,
                ..
            } => {
                let original_record = must_get_valid_record(original_action_hash)?;
                let original_action = original_record.action().clone();
                let original_action = match original_action {
                    Action::Create(create) => EntryCreationAction::Create(create),
                    Action::Update(update) => EntryCreationAction::Update(update),
                    _ => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "Original action for an update must be a Create or Update action"
                                .to_string(),
                        ));
                    }
                };
                match app_entry {
                    EntryTypes::RoomInfo(room_info) => {
                        let result = validate_create_room_info(
                            EntryCreationAction::Update(action.clone()),
                            room_info.clone(),
                        )?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_room_info: Option<RoomInfo> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let original_room_info = match original_room_info {
                                Some(room_info) => room_info,
                                None => {
                                    return Ok(
                                            ValidateCallbackResult::Invalid(
                                                "The updated entry type must be the same as the original entry type"
                                                    .to_string(),
                                            ),
                                        );
                                }
                            };
                            validate_update_room_info(
                                action,
                                room_info,
                                original_action,
                                original_room_info,
                            )
                        } else {
                            Ok(result)
                        }
                    }
                    EntryTypes::Attachment(attachment) => {
                        let result = validate_create_attachment(
                            EntryCreationAction::Update(action.clone()),
                            attachment.clone(),
                        )?;
                        if let ValidateCallbackResult::Valid = result {
                            let original_attachment: Option<Attachment> = original_record
                                .entry()
                                .to_app_option()
                                .map_err(|e| wasm_error!(e))?;
                            let original_attachment = match original_attachment {
                                Some(attachment) => attachment,
                                None => {
                                    return Ok(
                                            ValidateCallbackResult::Invalid(
                                                "The updated entry type must be the same as the original entry type"
                                                    .to_string(),
                                            ),
                                        );
                                }
                            };
                            validate_update_attachment(
                                action,
                                attachment,
                                original_action,
                                original_attachment,
                            )
                        } else {
                            Ok(result)
                        }
                    }
                }
            }
            OpRecord::DeleteEntry {
                original_action_hash,
                action,
                ..
            } => {
                let original_record = must_get_valid_record(original_action_hash)?;
                let original_action = original_record.action().clone();
                let original_action = match original_action {
                    Action::Create(create) => EntryCreationAction::Create(create),
                    Action::Update(update) => EntryCreationAction::Update(update),
                    _ => {
                        return Ok(ValidateCallbackResult::Invalid(
                            "Original action for a delete must be a Create or Update action"
                                .to_string(),
                        ));
                    }
                };
                let app_entry_type = match original_action.entry_type() {
                    EntryType::App(app_entry_type) => app_entry_type,
                    _ => {
                        return Ok(ValidateCallbackResult::Valid);
                    }
                };
                let entry = match original_record.entry().as_option() {
                    Some(entry) => entry,
                    None => {
                        if original_action.entry_type().visibility().is_public() {
                            return Ok(
                                    ValidateCallbackResult::Invalid(
                                        "Original record for a delete of a public entry must contain an entry"
                                            .to_string(),
                                    ),
                                );
                        } else {
                            return Ok(ValidateCallbackResult::Valid);
                        }
                    }
                };
                let original_app_entry = match EntryTypes::deserialize_from_type(
                    app_entry_type.zome_index.clone(),
                    app_entry_type.entry_index.clone(),
                    &entry,
                )? {
                    Some(app_entry) => app_entry,
                    None => {
                        return Ok(
                                ValidateCallbackResult::Invalid(
                                    "Original app entry must be one of the defined entry types for this zome"
                                        .to_string(),
                                ),
                            );
                    }
                };
                match original_app_entry {
                    EntryTypes::RoomInfo(original_room_info) => {
                        validate_delete_room_info(action, original_action, original_room_info)
                    }
                    EntryTypes::Attachment(original_attachment) => {
                        validate_delete_attachment(action, original_action, original_attachment)
                    }
                }
            }
            OpRecord::CreateLink {
                base_address,
                target_address,
                tag,
                link_type,
                action,
            } => match link_type {
                LinkTypes::RoomInfoUpdates => validate_create_link_room_info_updates(
                    action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllAgents => {
                    validate_create_link_all_agents(action, base_address, target_address, tag)
                }
                LinkTypes::AllDescendentRooms => validate_create_link_all_descendent_rooms(
                    action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AttachmentUpdates => validate_create_link_attachment_updates(
                    action,
                    base_address,
                    target_address,
                    tag,
                ),
                LinkTypes::AllAttachments => {
                    validate_create_link_all_attachments(action, base_address, target_address, tag)
                }
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
                    LinkTypes::RoomInfoUpdates => validate_delete_link_room_info_updates(
                        action,
                        create_link.clone(),
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AllAgents => validate_delete_link_all_agents(
                        action,
                        create_link.clone(),
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AllDescendentRooms => validate_delete_link_all_descendent_rooms(
                        action,
                        create_link.clone(),
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AttachmentUpdates => validate_delete_link_attachment_updates(
                        action,
                        create_link.clone(),
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
                    LinkTypes::AllAttachments => validate_delete_link_all_attachments(
                        action,
                        create_link.clone(),
                        base_address,
                        create_link.target_address,
                        create_link.tag,
                    ),
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
