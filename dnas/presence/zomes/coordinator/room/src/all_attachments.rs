use hdk::prelude::*;
use room_integrity::*;
#[hdk_extern]
pub fn get_all_attachments(_: ()) -> ExternResult<Vec<Record>> {
    let path = Path::from("all_attachments");
    let links = get_links(
        GetLinksInputBuilder::try_new(path.path_entry_hash()?, LinkTypes::AllAttachments)?.build(),
    )?;
    let mut attachments = Vec::new();
    for link in links {
        match ActionHash::try_from(link.target) {
            Ok(ah) => {
                let maybe_record = get(ah, GetOptions::default())?;
                if let Some(record) = maybe_record {
                    attachments.push(record);
                }
            }
            Err(_) => (),
        }
    }
    Ok(attachments)
}
