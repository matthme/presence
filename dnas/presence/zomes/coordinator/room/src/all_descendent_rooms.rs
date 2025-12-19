use hdk::prelude::*;
use room_integrity::*;
pub const ALL_DESCENDENT_ROOMS: &str = "ALL_DESCENDENT_ROOMS";

#[hdk_extern]
pub fn create_descendent_room(input: DescendentRoom) -> ExternResult<ActionHash> {
    let path = Path::from(ALL_DESCENDENT_ROOMS);
    let room_entry_hash = hash_entry(input.clone())?;
    create_entry(EntryTypes::DescendentRoom(input))?;

    create_link(
        path.path_entry_hash()?,
        room_entry_hash,
        LinkTypes::AllDescendentRooms,
        (),
    )
}

/// Deletes the link from the anchor to that descendent room
#[hdk_extern]
pub fn delete_descendent_room(action_hash: ActionHash) -> ExternResult<ActionHash> {
    delete_link(action_hash, GetOptions::local())
}

#[hdk_extern]
pub fn get_all_descendent_rooms(
    _: (),
) -> ExternResult<Vec<(DescendentRoom, AgentPubKey, ActionHash)>> {
    let path = Path::from(ALL_DESCENDENT_ROOMS);
    let links = get_links(
        LinkQuery::try_new(path.path_entry_hash()?, LinkTypes::AllDescendentRooms)?,
        GetStrategy::Local,
    )?;
    let mut result = Vec::new();
    for link in links {
        match EntryHash::try_from(link.target) {
            Ok(eh) => {
                let maybe_record = get(eh, GetOptions::local())?;
                if let Some(record) = maybe_record {
                    let maybe_descendent_room =
                        record.entry().to_app_option::<DescendentRoom>().ok();
                    if let Some(Some(descendent_room)) = maybe_descendent_room {
                        result.push((descendent_room, link.author, link.create_link_hash));
                    }
                }
            }
            Err(_) => (),
        }
    }
    // In principle it would be possible that we get duplicate rooms here since there may be multiple
    // links pointing to the same room. However since the UI side creation process generates a UUID
    // this possibility is neglected here as it shouldn't happen in practice.
    Ok(result)
}
