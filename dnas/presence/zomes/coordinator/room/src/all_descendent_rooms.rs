use hdk::prelude::*;
use room_integrity::*;
pub const ALL_DESCENDENT_ROOMS: &str = "ALL_DESCENDENT_ROOMS";
#[derive(Serialize, Deserialize, Debug)]
pub struct DescendentRoom {
    creator: AgentPubKey,
    network_seed_appendix: String,
    link_action_hash: ActionHash,
}
#[hdk_extern]
pub fn get_all_descendent_rooms(_: ()) -> ExternResult<Vec<DescendentRoom>> {
    let path = Path::from(ALL_DESCENDENT_ROOMS);
    let links = get_links(
        GetLinksInputBuilder::try_new(path.path_entry_hash()?, LinkTypes::AllDescendentRooms)?
            .build(),
    )?;
    let mut result = Vec::new();
    for link in links {
        let creator = match AgentPubKey::try_from(link.target) {
            Ok(agent) => Some(agent),
            Err(_) => None,
        };
        if let Some(agent) = creator {
            let maybe_network_seed_appendix = String::from_utf8(link.tag.as_ref().to_vec()).ok();
            if let Some(network_seed_appendix) = maybe_network_seed_appendix {
                result.push(DescendentRoom {
                    creator: agent,
                    network_seed_appendix,
                    link_action_hash: link.create_link_hash,
                })
            }
        }
    }
    Ok(result)
}
#[hdk_extern]
pub fn create_descendent_room(network_seed_appendix: String) -> ExternResult<ActionHash> {
    let path = Path::from(ALL_DESCENDENT_ROOMS);
    create_link(
        path.path_entry_hash()?,
        agent_info()?.agent_initial_pubkey,
        LinkTypes::AllDescendentRooms,
        LinkTag::new(network_seed_appendix),
    )
}
