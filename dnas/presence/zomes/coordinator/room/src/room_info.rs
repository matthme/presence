use hdk::prelude::*;
use room_integrity::*;
use crate::helper::ZomeFnInput;

// If this function returns None, it means that we haven't synced up yet
#[hdk_extern]
pub fn get_room_info(input: ZomeFnInput<()>) -> ExternResult<Option<Record>> {
    let path = Path::from(ROOM_INFO);
    let get_strategy = input.get_strategy();
    let links = get_links(
        LinkQuery::try_new(path.path_entry_hash()?, LinkTypes::RoomInfoUpdates)?,
        get_strategy,
    )?;

    let latest_room_info_link = links
        .into_iter()
        .max_by(|link_a, link_b| link_b.timestamp.cmp(&link_a.timestamp));

    let get_options: GetOptions = input.get_options();
    match latest_room_info_link {
        None => Ok(None),
        Some(link) => {
            let record = get(
                // ActionHash::from(link.target),
                ActionHash::try_from(link.target)
                    .map_err(|e| wasm_error!(WasmErrorInner::from(e)))?,
                get_options
            )?;

            Ok(record)
        }
    }
}

#[hdk_extern]
pub fn set_room_info(room_info: RoomInfo) -> ExternResult<()> {
    let path = Path::from(ROOM_INFO);

    let action_hash = create_entry(EntryTypes::RoomInfo(room_info))?;

    create_link(
        path.path_entry_hash()?,
        action_hash,
        LinkTypes::RoomInfoUpdates,
        (),
    )?;

    Ok(())
}
