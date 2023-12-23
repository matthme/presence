pub mod anchor_to_agent;
pub mod remote_signals;

use hdk::prelude::*;
use unzoom_integrity::*;
// Called the first time a zome call is made to the cell containing this zome
#[hdk_extern]
pub fn init(_: ()) -> ExternResult<InitCallbackResult> {
    let mut functions = BTreeSet::new();
    functions.insert((zome_info()?.name, FunctionName("recv_remote_signal".into())));
    let cap_grant_entry: CapGrantEntry = CapGrantEntry::new(
        String::from("Receiving remote signals"), // A string by which to later query for saved grants.
        ().into(), // Unrestricted access means any external agent can call the extern
        GrantedFunctions::Listed(functions),
    );

    create_cap_grant(cap_grant_entry)?;
    Ok(InitCallbackResult::Pass)
}

// Don't modify this enum if you want the scaffolding tool to generate appropriate signals for your entries and links
#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum Signal {
    LinkCreated {
        action: SignedActionHashed,
        link_type: LinkTypes,
    },
    LinkDeleted {
        action: SignedActionHashed,
        link_type: LinkTypes,
    },
}
// Whenever an action is committed, we emit a signal to the UI elements to reactively update them
#[hdk_extern(infallible)]
pub fn post_commit(committed_actions: Vec<SignedActionHashed>) {
    // Don't modify this loop if you want the scaffolding tool to generate appropriate signals for your entries and links
    for action in committed_actions {
        if let Err(err) = signal_action(action) {
            error!("Error signaling new action: {:?}", err);
        }
    }
}
// Don't modify this function if you want the scaffolding tool to generate appropriate signals for your entries and links
fn signal_action(action: SignedActionHashed) -> ExternResult<()> {
    match action.hashed.content.clone() {
        Action::CreateLink(create_link) => {
            if let Ok(Some(link_type)) =
                LinkTypes::from_type(create_link.zome_index, create_link.link_type)
            {
                emit_signal(Signal::LinkCreated { action, link_type })?;
            }
            Ok(())
        }
        Action::DeleteLink(delete_link) => {
            let record = get(delete_link.link_add_address.clone(), GetOptions::default())?.ok_or(
                wasm_error!(WasmErrorInner::Guest(
                    "Failed to fetch CreateLink action".to_string()
                )),
            )?;
            match record.action() {
                Action::CreateLink(create_link) => {
                    if let Ok(Some(link_type)) =
                        LinkTypes::from_type(create_link.zome_index, create_link.link_type)
                    {
                        emit_signal(Signal::LinkDeleted { action, link_type })?;
                    }
                    Ok(())
                }
                _ => {
                    return Err(wasm_error!(WasmErrorInner::Guest(
                        "Create Link should exist".to_string()
                    )));
                }
            }
        }
        _ => Ok(()),
    }
}
