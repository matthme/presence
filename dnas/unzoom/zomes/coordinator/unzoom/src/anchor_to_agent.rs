use hdk::prelude::*;
use unzoom_integrity::*;

pub const ALL_AGENTS: &str = "ALL_AGENTS";

#[hdk_extern]
pub fn add_agent_to_anchor(_: ()) -> ExternResult<()> {
    let all_agents_anchor = anchor(
        LinkTypes::AnchorToAgent,
        ALL_AGENTS.into(),
        ALL_AGENTS.into(),
    )?;
    let action_hash = create_link(
        all_agents_anchor.clone(),
        agent_info()?.agent_initial_pubkey,
        LinkTypes::AnchorToAgent,
        (),
    )?;
    let record = get(action_hash, GetOptions::default())?.unwrap();
    let action = record.action();
    match action {
        Action::CreateLink(link) => {
            debug!(
                "Adding agent to anchor with pubkey: {:?}\nbase_address: {:?}\naction author: {:?}\ntarget_address: {:?}",
                agent_info()?.agent_initial_pubkey,
                all_agents_anchor,
                action.author(),
                link.target_address,
            );
        }
        _ => (),
    }

    Ok(())
}

#[hdk_extern]
pub fn get_all_agents(_: ()) -> ExternResult<Vec<AgentPubKey>> {
    let all_agents_anchor = anchor(
        LinkTypes::AnchorToAgent,
        ALL_AGENTS.into(),
        ALL_AGENTS.into(),
    )?;

    let links = get_links(
        GetLinksInputBuilder::try_new(all_agents_anchor, LinkTypes::AnchorToAgent)?.build(),
    )?;

    Ok(links
        .into_iter()
        .map(|link| AgentPubKey::try_from(link.target).ok())
        .filter_map(|pubkey| pubkey)
        .collect::<Vec<AgentPubKey>>())
}
