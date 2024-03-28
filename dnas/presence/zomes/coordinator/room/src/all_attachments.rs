use hdk::prelude::*;
use room_integrity::*;
#[hdk_extern]
pub fn get_all_attachments(_: ()) -> ExternResult<Vec<Record<Attachment>>> {
    let path = Path::from("all_attachments");
    let links = get_links(
        GetLinksInputBuilder::try_new(path.path_entry_hash()?, LinkTypes::AllAttachments)?.build(),
    )?;
    let mut attachments = Vec::new();
    for link in links {
        let maybe_record = get(link.target, GetOptions::default())?;
        if let Some(record) = maybe_record {
            attachments.push(record);
        }
    }
    Ok(attachments)
}
