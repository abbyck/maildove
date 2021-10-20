import EmailAddrParser from 'email-addresses';

class EmailUtils {
    /***
     * Get all the email addresses from the `addresses` string and convert
     * it to an array.
     * @param addresses String containing recipient addresses.
     * @returns {string[]} An array containing all the email addresses.
     */
    public getAddressesFromString(addresses: string): string[] {
        const results: string[] = [];
        let addressesArray: string[] = [];
        if (!Array.isArray(addresses)) {
            addressesArray = addresses.split(',');
        }
        addressesArray.forEach((email) => {
            const parsedEmail = EmailAddrParser.parseOneAddress(email);
            if (parsedEmail !== null && parsedEmail.type === 'mailbox') {
                results.push(parsedEmail.address);
            }
        })
        return results;
    }

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
