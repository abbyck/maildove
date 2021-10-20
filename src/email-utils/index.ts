import EmailAddrParser from 'email-addresses';

class EmailUtils {
    /**
     * Get all the recipients grouped by domain name.
     * @param recipients String containing all the recipients.
     * @returns {Record<string, string[]>} Recipients grouped by domain name.
     */
    public groupRecipientsByDomain(
        recipients: string[]
    ): Record<string, string[]> {
        const recipientGroups = {};
        for (const recipient of recipients) {
            const parsedEmail = EmailAddrParser.parseOneAddress(recipient);
            if (parsedEmail !== null && parsedEmail.type === 'mailbox') {
                let host = parsedEmail.domain;
                (recipientGroups[host] || (recipientGroups[host] = [])).push(
                    recipient
                );
            }
        }
        return recipientGroups;
    }
}

export { EmailUtils };
