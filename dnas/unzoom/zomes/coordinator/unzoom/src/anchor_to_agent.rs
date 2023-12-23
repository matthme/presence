use hdk::prelude::*;
use unzoom_integrity::*;

const ALL_AGENTS: &str = "ALL_AGENTS";

#[derive(Serialize, Deserialize, Debug)]
pub struct AnchorToAgentInput {
    pub agent: AgentPubKey,
}

#[hdk_extern]
pub fn add_anchor_to_agent_for_agent(input: AnchorToAgentInput) -> ExternResult<()> {
    let all_agents_anchor = anchor(
        LinkTypes::AnchorToAgent,
        "ALL_AGENTS".into(),
        "ALL_AGENTS".into(),
    )?;
    create_link(all_agents_anchor, input.agent, LinkTypes::AnchorToAgent, ())?;

    Ok(())
}

#[hdk_extern]
pub fn get_all_agents(_: ()) -> ExternResult<Vec<AgentPubKey>> {
    let all_agents_anchor = anchor(
        LinkTypes::AnchorToAgent,
        "ALL_AGENTS".into(),
        "ALL_AGENTS".into(),
    )?;
    let links = get_links(all_agents_anchor, LinkTypes::AnchorToAgent, None)?;
    Ok(links
        .into_iter()
        .map(|link| AgentPubKey::try_from(link.target).ok())
        .filter_map(|pubkey| pubkey)
        .collect::<Vec<AgentPubKey>>())
}
