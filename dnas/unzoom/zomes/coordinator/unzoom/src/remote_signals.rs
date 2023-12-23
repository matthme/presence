use hdk::prelude::*;

#[derive(Serialize, Deserialize, SerializedBytes, Debug, Clone)]
#[serde(tag = "type")]
pub enum SignalPayload {
    Ping {
        from_agent: AgentPubKey,
    },
    Pong {
        from_agent: AgentPubKey,
    },
    SdpOffer {
        timestamp: i32,
        offer: String,
    },
    SdpResponse {
        offer_timestamp: i32,
        response: String,
    },
}

#[hdk_extern]
pub fn recv_remote_signal(signal: ExternIO) -> ExternResult<()> {
    let signal_payload: SignalPayload = signal
        .decode()
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    match signal_payload.clone() {
        SignalPayload::Ping { from_agent } => pong(from_agent),
        SignalPayload::Pong { .. } => emit_signal(signal_payload),
        SignalPayload::SdpOffer { .. } => emit_signal(signal_payload),
        SignalPayload::SdpResponse { .. } => emit_signal(signal_payload),
    }
}

/// Send a remote signal to the given users to check whether they are online
/// After this ping is sent, a pong is expected as soon as the agents receive the signal
#[hdk_extern]
pub fn ping(agents_pub_keys: Vec<AgentPubKey>) -> ExternResult<()> {
    let signal_payload = SignalPayload::Ping {
        from_agent: agent_info()?.agent_initial_pubkey,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, agents_pub_keys)
}

fn pong(from_agent: AgentPubKey) -> ExternResult<()> {
    let signal_payload = SignalPayload::Pong {
        from_agent: agent_info()?.agent_initial_pubkey,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, vec![from_agent])
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SdpOfferInput {
    pub timestamp: i32, // unix epoch time in ms
    pub offer: String,
    pub other_connected_peers: Option<Vec<AgentPubKey>>,
    pub to_agents: Vec<AgentPubKey>,
}

#[hdk_extern]
pub fn send_offer(input: SdpOfferInput) -> ExternResult<()> {
    let signal_payload = SignalPayload::SdpOffer {
        timestamp: input.timestamp,
        offer: input.offer,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, input.to_agents)
}
