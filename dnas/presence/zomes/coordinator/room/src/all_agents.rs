use hdk::prelude::*;
use room_integrity::*;
pub const ALL_AGENTS: &str = "ALL_AGENTS";
#[hdk_extern]
pub fn get_all_agents(_: ()) -> ExternResult<Vec<AgentPubKey>> {
    let path = Path::from(ALL_AGENTS);
    let links = get_links(
        GetLinksInputBuilder::try_new(path.path_entry_hash()?, LinkTypes::AllAgents)?.build(),
    )?;
    Ok(links
        .into_iter()
        .filter_map(|link| AgentPubKey::try_from(link.target).ok())
        .collect())
}
#[hdk_extern]
pub fn add_agent_to_anchor(_: ()) -> ExternResult<ActionHash> {
    let path = Path::from(ALL_AGENTS);
    create_link(
        path.path_entry_hash()?,
        agent_info()?.agent_initial_pubkey,
        LinkTypes::AllAgents,
        (),
    )
}
