use hdk::prelude::*;
use room_integrity::*;
#[hdk_extern]
pub fn create_room_info(room_info: RoomInfo) -> ExternResult<Record> {
    let room_info_hash = create_entry(&EntryTypes::RoomInfo(room_info.clone()))?;
    let record = get(room_info_hash.clone(), GetOptions::default())?.ok_or(wasm_error!(
        WasmErrorInner::Guest(String::from("Could not find the newly created RoomInfo"))
    ))?;
    let path = Path::from("all_agents");
    create_link(
        path.path_entry_hash()?,
        room_info_hash.clone(),
        LinkTypes::AllAgents,
        (),
    )?;
    let path = Path::from("all_descendent_rooms");
    create_link(
        path.path_entry_hash()?,
        room_info_hash.clone(),
        LinkTypes::AllDescendentRooms,
        (),
    )?;
    Ok(record)
}
#[hdk_extern]
pub fn get_latest_room_info(original_room_info_hash: ActionHash) -> ExternResult<Option<Record>> {
    let links = get_links(
        GetLinksInputBuilder::try_new(original_room_info_hash.clone(), LinkTypes::RoomInfoUpdates)?
            .build(),
    )?;
    let latest_link = links
        .into_iter()
        .max_by(|link_a, link_b| link_a.timestamp.cmp(&link_b.timestamp));
    let latest_room_info_hash = match latest_link {
        Some(link) => {
            link.target
                .clone()
                .into_action_hash()
                .ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
                    "No action hash associated with link"
                ))))?
        }
        None => original_room_info_hash.clone(),
    };
    get(latest_room_info_hash, GetOptions::default())
}
#[hdk_extern]
pub fn get_original_room_info(original_room_info_hash: ActionHash) -> ExternResult<Option<Record>> {
    let Some(details) = get_details(original_room_info_hash, GetOptions::default())? else {
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
pub fn get_all_revisions_for_room_info(
    original_room_info_hash: ActionHash,
) -> ExternResult<Vec<Record>> {
    let Some(original_record) = get_original_room_info(original_room_info_hash.clone())? else {
        return Ok(vec![]);
    };
    let links = get_links(
        GetLinksInputBuilder::try_new(original_room_info_hash.clone(), LinkTypes::RoomInfoUpdates)?
            .build(),
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
pub struct UpdateRoomInfoInput {
    pub original_room_info_hash: ActionHash,
    pub previous_room_info_hash: ActionHash,
    pub updated_room_info: RoomInfo,
}
#[hdk_extern]
pub fn update_room_info(input: UpdateRoomInfoInput) -> ExternResult<Record> {
    let updated_room_info_hash = update_entry(
        input.previous_room_info_hash.clone(),
        &input.updated_room_info,
    )?;
    create_link(
        input.original_room_info_hash.clone(),
        updated_room_info_hash.clone(),
        LinkTypes::RoomInfoUpdates,
        (),
    )?;
    let record = get(updated_room_info_hash.clone(), GetOptions::default())?.ok_or(wasm_error!(
        WasmErrorInner::Guest(String::from("Could not find the newly updated RoomInfo"))
    ))?;
    Ok(record)
}
