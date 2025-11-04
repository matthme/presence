use hdk::prelude::*;
use room_integrity::*;
#[hdk_extern]
pub fn create_attachment(attachment: Attachment) -> ExternResult<Record> {
    let attachment_hash = create_entry(&EntryTypes::Attachment(attachment.clone()))?;
    let record = get(attachment_hash.clone(), GetOptions::default())?.ok_or(wasm_error!(
        WasmErrorInner::Guest(String::from("Could not find the newly created Attachment"))
    ))?;
    let path = Path::from("all_attachments");
    create_link(
        path.path_entry_hash()?,
        attachment_hash.clone(),
        LinkTypes::AllAttachments,
        (),
    )?;
    Ok(record)
}
#[hdk_extern]
pub fn get_latest_attachment(original_attachment_hash: ActionHash) -> ExternResult<Option<Record>> {
    let links = get_links(
        LinkQuery::try_new(
            original_attachment_hash.clone(),
            LinkTypes::AttachmentUpdates,
        )?,
        GetStrategy::Network,
    )?;
    let latest_link = links
        .into_iter()
        .max_by(|link_a, link_b| link_a.timestamp.cmp(&link_b.timestamp));
    let latest_attachment_hash = match latest_link {
        Some(link) => {
            link.target
                .clone()
                .into_action_hash()
                .ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
                    "No action hash associated with link"
                ))))?
        }
        None => original_attachment_hash.clone(),
    };
    get(latest_attachment_hash, GetOptions::default())
}
#[hdk_extern]
pub fn get_original_attachment(
    original_attachment_hash: ActionHash,
) -> ExternResult<Option<Record>> {
    let Some(details) = get_details(original_attachment_hash, GetOptions::default())? else {
        return Ok(None);
    };
    match details {
        Details::Record(details) => Ok(Some(details.record)),
        _ => Err(wasm_error!(WasmErrorInner::Guest(String::from(
            "Malformed get details response"
        )))),
    }
}
#[hdk_extern]
pub fn get_all_revisions_for_attachment(
    original_attachment_hash: ActionHash,
) -> ExternResult<Vec<Record>> {
    let Some(original_record) = get_original_attachment(original_attachment_hash.clone())? else {
        return Ok(vec![]);
    };
    let links = get_links(
        LinkQuery::try_new(
            original_attachment_hash.clone(),
            LinkTypes::AttachmentUpdates,
        )?,
        GetStrategy::Network,
    )?;
    let get_input: Vec<GetInput> = links
        .into_iter()
        .map(|link| {
            Ok(GetInput::new(
                link.target
                    .into_action_hash()
                    .ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
                        "No action hash associated with link"
                    ))))?
                    .into(),
                GetOptions::default(),
            ))
        })
        .collect::<ExternResult<Vec<GetInput>>>()?;
    let records = HDK.with(|hdk| hdk.borrow().get(get_input))?;
    let mut records: Vec<Record> = records.into_iter().filter_map(|r| r).collect();
    records.insert(0, original_record);
    Ok(records)
}
#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateAttachmentInput {
    pub original_attachment_hash: ActionHash,
    pub previous_attachment_hash: ActionHash,
    pub updated_attachment: Attachment,
}
#[hdk_extern]
pub fn update_attachment(input: UpdateAttachmentInput) -> ExternResult<Record> {
    let updated_attachment_hash = update_entry(
        input.previous_attachment_hash.clone(),
        &input.updated_attachment,
    )?;
    create_link(
        input.original_attachment_hash.clone(),
        updated_attachment_hash.clone(),
        LinkTypes::AttachmentUpdates,
        (),
    )?;
    let record =
        get(updated_attachment_hash.clone(), GetOptions::default())?.ok_or(wasm_error!(
            WasmErrorInner::Guest(String::from("Could not find the newly updated Attachment"))
        ))?;
    Ok(record)
}
#[hdk_extern]
pub fn delete_attachment(original_attachment_hash: ActionHash) -> ExternResult<ActionHash> {
    let details = get_details(original_attachment_hash.clone(), GetOptions::default())?.ok_or(
        wasm_error!(WasmErrorInner::Guest(String::from(
            "{pascal_entry_def_name} not found"
        ))),
    )?;
    let _record = match details {
        Details::Record(details) => Ok(details.record),
        _ => Err(wasm_error!(WasmErrorInner::Guest(String::from(
            "Malformed get details response"
        )))),
    }?;
    let path = Path::from("all_attachments");
    let links = get_links(
        LinkQuery::try_new(path.path_entry_hash()?, LinkTypes::AllAttachments)?,
        GetStrategy::Network,
    )?;
    for link in links {
        if let Some(hash) = link.target.into_action_hash() {
            if hash.eq(&original_attachment_hash) {
                delete_link(link.create_link_hash, GetOptions::network())?;
            }
        }
    }
    delete_entry(original_attachment_hash)
}
#[hdk_extern]
pub fn get_all_deletes_for_attachment(
    original_attachment_hash: ActionHash,
) -> ExternResult<Option<Vec<SignedActionHashed>>> {
    let Some(details) = get_details(original_attachment_hash, GetOptions::default())? else {
        return Ok(None);
    };
    match details {
        Details::Entry(_) => Err(wasm_error!(WasmErrorInner::Guest(
            "Malformed details".into()
        ))),
        Details::Record(record_details) => Ok(Some(record_details.deletes)),
    }
}
#[hdk_extern]
pub fn get_oldest_delete_for_attachment(
    original_attachment_hash: ActionHash,
) -> ExternResult<Option<SignedActionHashed>> {
    let Some(mut deletes) = get_all_deletes_for_attachment(original_attachment_hash)? else {
        return Ok(None);
    };
    deletes.sort_by(|delete_a, delete_b| {
        delete_a
            .action()
            .timestamp()
            .cmp(&delete_b.action().timestamp())
    });
    Ok(deletes.first().cloned())
}
