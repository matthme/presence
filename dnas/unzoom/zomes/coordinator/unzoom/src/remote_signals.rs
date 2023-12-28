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
    PingUi {
        from_agent: AgentPubKey,
    },
    PongUi {
        from_agent: AgentPubKey,
    },
    InitRequest {
        from_agent: AgentPubKey,
        connection_id: String,
    },
    InitAccept {
        from_agent: AgentPubKey,
        connection_id: String,
    },
    SdpData {
        from_agent: AgentPubKey,
        connection_id: String,
        data: String,
    },
}

#[hdk_extern]
pub fn recv_remote_signal(signal: ExternIO) -> ExternResult<()> {
    let signal_payload: SignalPayload = signal
        .decode()
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    debug!("### GOT REMOTE SIGNAL ###");
    match signal_payload.clone() {
        SignalPayload::Ping { from_agent } => pong(from_agent),
        SignalPayload::Pong { .. } => emit_signal(signal_payload),
        SignalPayload::PingUi { .. } => emit_signal(signal_payload),
        SignalPayload::PongUi { .. } => emit_signal(signal_payload),
        SignalPayload::InitRequest { .. } => emit_signal(signal_payload),
        SignalPayload::InitAccept { .. } => emit_signal(signal_payload),
        SignalPayload::SdpData { .. } => emit_signal(signal_payload),
    }
}

/// Send a remote signal to the given users to check whether they are online
/// After this ping is sent, a pong is expected as soon as the agents receive the signal
/// NOTE: The pong to this ping is automatically emitted in the backend, independent
/// of whether the UI for that cell is currently running
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

/// Send a remote signal to the given users to check whether they are online AND their UI is running
/// The pong to this ping needs to be emitted by the UI of the other agent
#[hdk_extern]
pub fn ping_ui(agents_pub_keys: Vec<AgentPubKey>) -> ExternResult<()> {
    let signal_payload = SignalPayload::PingUi {
        from_agent: agent_info()?.agent_initial_pubkey,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, agents_pub_keys)
}

/// Respond with a pong to a PongUi signal. Needs to be actively called by the UI.
#[hdk_extern]
pub fn pong_ui(agent_pub_key: AgentPubKey) -> ExternResult<()> {
    let signal_payload = SignalPayload::PongUi {
        from_agent: agent_info()?.agent_initial_pubkey,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, vec![agent_pub_key])
}

#[derive(Serialize, Deserialize, Debug)]
pub struct InitRequestInput {
    pub connection_type: Option<String>, // e.g. "screen" for screen sharing
    pub connection_id: String,
    pub to_agent: AgentPubKey,
}

#[hdk_extern]
pub fn send_init_request(input: InitRequestInput) -> ExternResult<()> {
    let signal_payload = SignalPayload::InitRequest {
        from_agent: agent_info()?.agent_initial_pubkey,
        connection_id: input.connection_id,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, vec![input.to_agent])
}

#[derive(Serialize, Deserialize, Debug)]
pub struct InitAcceptInput {
    pub connection_type: Option<String>, // e.g. "screen" for screen sharing
    pub connection_id: String,
    pub to_agent: AgentPubKey,
}

#[hdk_extern]
pub fn send_init_accept(input: InitAcceptInput) -> ExternResult<()> {
    let signal_payload = SignalPayload::InitAccept {
        from_agent: agent_info()?.agent_initial_pubkey,
        connection_id: input.connection_id,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, vec![input.to_agent])
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SdpDataInput {
    pub to_agent: AgentPubKey,
    pub connection_id: String,
    pub data: String,
}

#[hdk_extern]
pub fn send_sdp_data(input: SdpDataInput) -> ExternResult<()> {
    let signal_payload = SignalPayload::SdpData {
        from_agent: agent_info()?.agent_initial_pubkey,
        connection_id: input.connection_id,
        data: input.data,
    };

    let encoded_signal = ExternIO::encode(signal_payload)
        .map_err(|err| wasm_error!(WasmErrorInner::Guest(err.into())))?;

    remote_signal(encoded_signal, vec![input.to_agent])
}
