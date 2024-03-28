use hdk::prelude::*;
use room_integrity::*;

// If this function returns None, it means that we haven't synced up yet
#[hdk_extern]
pub fn get_room_info(_: ()) -> ExternResult<Option<Record>> {
    let path = Path::from(ROOM_INFO);

    let links = get_links(
        GetLinksInputBuilder::try_new(path.path_entry_hash()?, LinkTypes::RoomInfoUpdates)?.build(),
    )?;

    let latest_room_info_link = links
        .into_iter()
        .max_by(|link_a, link_b| link_b.timestamp.cmp(&link_a.timestamp));

    match latest_room_info_link {
        None => Ok(None),
        Some(link) => {
            let record = get(
                // ActionHash::from(link.target),
                ActionHash::try_from(link.target)
                    .map_err(|e| wasm_error!(WasmErrorInner::from(e)))?,
                GetOptions::default(),
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
