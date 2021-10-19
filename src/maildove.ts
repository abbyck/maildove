import EmailAddrParser from 'email-addresses';
import { promises } from 'dns';
import { connect, createSecureContext } from 'tls';
import { createConnection } from 'net';
import MailComposer from "nodemailer/lib/mail-composer";
import { DKIMSign } from 'dkim-signer';
import { Options } from 'nodemailer/lib/mailer';

const resolver = new promises.Resolver();
const CRLF = '\r\n';

const smtpCodes = {
    ServiceReady: 220,
    Bye: 221,
    AuthSuccess: 235,
    OperationOK: 250,
    ForwardNonLocalUser: 251,
    StartMailBody: 354,
    ServerChallenge: 334,
    NegativeCompletion: 400,
};

interface MXRecord {
    exchange: string,
    priority: number
}

interface tlsInterface {
    key: string
    cert: string
}

interface MailDoveOptions {
    smtpPort?: number;
    smtpHost?: string;
    dkimEnabled?: boolean;
    dkimPrivateKey?: string;
    dkimKeySelector?: string;
    startTLS?: boolean;
    rejectUnauthorized?: boolean;
    tls?: tlsInterface;
}

class MailDove {
    smtpPort: number;
    smtpHost?: string;
    dkimEnabled: boolean;
    dkimPrivateKey: string;
    dkimKeySelector: string;
    startTLS: boolean;
    rejectUnauthorized: boolean;
    tls: tlsInterface;

    constructor(options: MailDoveOptions) {
        this.dkimEnabled = options.dkimEnabled || false;
        this.dkimKeySelector = options.dkimKeySelector || "";
        this.dkimPrivateKey = options.dkimPrivateKey || "";
        this.smtpPort = options.smtpPort || 25;
        this.smtpHost = options.smtpHost;
        this.startTLS = options.startTLS || false;
        this.rejectUnauthorized = options.rejectUnauthorized || true;
        this.tls = options.tls || { key: "", cert: "" }
    }

    public groupRecipients(recipients: string[]) {
        const groups = {};
        for (const recipient of recipients) {
            const parsedEmail = EmailAddrParser.parseOneAddress(recipient);
            if (parsedEmail !== null && parsedEmail.type === "mailbox") {
                let host = parsedEmail.domain;
                (groups[host] || (groups[host] = [])).push(recipient);
            }
        }
        return groups;
    }

    /***
     * Get email addresses from address string.
     * @param addresses
     * @returns {*[]}
     */
    public getAddresses(addresses): string[] {
        const results: string[] = [];
        if (!Array.isArray(addresses)) {
            addresses = addresses.split(',');
        }
        const addressesLength = addresses.length;
        for (let i = 0; i < addressesLength; i++) {
            const parsedEmail = EmailAddrParser.parseOneAddress(addresses[i]);
            if (parsedEmail !== null && parsedEmail.type === "mailbox") {
                results.push(parsedEmail.address);
            }
        }
        return results;
    }

    /**
     * Resolve MX records by domain.
     * @param {string} domain
     * @returns {Promise<MXRecord[]>}
     */
    async resolveMX(domain: string): Promise<MXRecord[]> {
        let resolvedMX = Array();
        console.log(typeof this.smtpHost);
        if (this.smtpHost !== '' && this.smtpHost) {
            resolvedMX.push({ exchange: this.smtpHost, priority: 1 });
            return resolvedMX;
        }
        try {
            resolvedMX = await resolver.resolveMx(domain);
            resolvedMX.sort(function (a, b) { return a.priority - b.priority; });
            return resolvedMX;
        }
        catch (ex) {
            throw Error(`Failed to resolve MX for ${domain}: ${ex}`);
        }
    }

    /***
     * Send email using SMTP.
     * @param {string}  domain    `to` address.
     * @param {string}  srcHost   Source hostname.
     * @param {string}  from      Source from address.
     * @param {string[]}recipients    Recipients list.
     * @param {string}  body      Email body
     * @returns {Promise<void>}
     */
    async sendToSMTP(domain: string, srcHost: string, from: string, recipients: string[], body: string): Promise<void> {
        const resolvedMX = await this.resolveMX(domain);
        console.info("Resolved mx list:", resolvedMX);
        let sock, msg = '';
        const self = this;
        function tryConnect(i: number) {
            if (i >= resolvedMX.length) {
                throw Error(`Could not connect to any SMTP server for ${domain}`);
            }

            sock = createConnection(self.smtpPort, resolvedMX[i].exchange);

            sock.on('error', function (err) {
                console.error('Error on connectMx for: ', resolvedMX[i], err);
                tryConnect(++i);
            });

            sock.on('connect', function () {
                console.debug('MX connection created: ', resolvedMX[i].exchange);
                sock.removeAllListeners('error');
                return sock;
            });
        }
        tryConnect(0);

        function onLine(line: string) {
            console.debug('RECV ' + domain + '>' + line);

            msg += (line + CRLF);

            if (line[3] === ' ') {
                // 250-information dash is not complete.
                // 250 OK. space is complete.
                let lineNumber = parseInt(line.substr(0, 3));
                response(lineNumber, msg);
                msg = '';
            }
        }

        function writeToSocket(s) {
            console.debug(`SEND ${domain}> ${s}`);
            sock.write(s + CRLF);
        }

        sock.setEncoding('utf8');

        sock.on('data', function (chunk) {
            data += chunk;
            parts = data.split(CRLF);
            const partsLength = parts.length - 1;
            for (let i = 0, len = partsLength; i < len; i++) {
                onLine(parts[i]);
            }
            data = parts[parts.length - 1];
        });

        sock.on('error', function (err: any) {
            throw Error(`Failed to connect to ${domain}: ${err}`);
        });

        let data = '';
        let step = 0;
        let consoleinStep = 0;
        const queue = Array();
        let parts: string | any[];
        let cmd: string;
        let upgraded = false;
        let isUpgradeInProgress = false;

        queue.push('MAIL FROM:<' + from + '>');
        const recipientsLength = recipients.length;
        for (let i = 0; i < recipientsLength; i++) {
            queue.push('RCPT TO:<' + recipients[i] + '>');
        }
        queue.push('DATA');
        queue.push('QUIT');
        queue.push('');

        function response(code: number, msg: string) {
            switch (code) {
                case smtpCodes.ServiceReady:
                    //220   on server ready
                    if (isUpgradeInProgress === true) {
                        sock.removeAllListeners('data');
                        let original = sock;
                        original.pause();
                        let opts: Record<string, any> = {
                            socket: sock,
                            host: sock._host,
                            rejectUnauthorized: self.rejectUnauthorized,
                        };
                        if (self.startTLS) {
                            opts.secureContext = createSecureContext({ cert: self.tls.cert, key: self.tls.key });
                        }
                        sock = connect(
                            opts,
                            () => {
                                sock.on('data', function (chunk) {
                                    data += chunk;
                                    parts = data.split(CRLF);
                                    const partsLength = parts.length - 1;
                                    for (let i = 0, len = partsLength; i < len; i++) {
                                        onLine(parts[i]);
                                    }
                                    data = parts[parts.length - 1];
                                });
                                sock.removeAllListeners('close');
                                sock.removeAllListeners('end');
                            }
                        );
                        sock.on('error', function (err: any) {
                            console.warn("Could not upgrade to TLS:", err, "Falling back to plaintext");
                        });
                        // TLS Unsuccessful -> Resume plaintext connection
                        original.resume();
                        upgraded = true;
                        writeToSocket("EHLO " + srcHost);
                        break;
                    }
                    else {
                        // check for ESMTP/ignore-case
                        if (/\besmtp\b/i.test(msg)) {
                            // TODO: determine AUTH type; auth consolein, auth crm-md5, auth plain
                            cmd = 'EHLO';
                        }
                        else {
                            upgraded = true;
                            cmd = 'HELO';
                        }
                        writeToSocket(`${cmd} ${srcHost}`);
                        break;
                    }
                case smtpCodes.Bye:
                    // BYE
                    sock.end();
                    console.info("message sent successfully", msg);
                    break;
                case smtpCodes.AuthSuccess: // Verify OK
                case smtpCodes.OperationOK: // Operation OK
                    if (upgraded !== true) {
                        // check for STARTTLS/ignore-case
                        if (/\bSTARTTLS\b/i.test(msg) && self.startTLS) {
                            console.debug("Server supports STARTTLS, continuing");
                            writeToSocket('STARTTLS');
                            isUpgradeInProgress = true;
                            break;
                        }
                        else {
                            upgraded = true;
                            console.debug("No STARTTLS support or ignored, continuing");
                        }
                    }
                    writeToSocket(queue[step]);
                    step++;
                    break;

                case smtpCodes.ForwardNonLocalUser:
                    // User not local; will forward.
                    if (step === queue.length - 1) {
                        console.info('OK:', code, msg);
                        return;
                    }
                    writeToSocket(queue[step]);
                    step++;
                    break;

                case smtpCodes.StartMailBody:
                    // Start mail input
                    // Inform end by `<CR><LF>.<CR><LF>`
                    console.info('Sending mail body', body);
                    writeToSocket(body);
                    writeToSocket('');
                    writeToSocket('.');
                    break;

                case smtpCodes.ServerChallenge:
                    // Send consolein details [for relay]
                    // TODO: support consolein.
                    // writeToSocket(consolein[consoleinStep]);
                    consoleinStep++;
                    break;

                default:
                    if (code >= smtpCodes.NegativeCompletion) {
                        console.error('SMTP server responds with error code', code);
                        sock.end();
                        throw Error(`SMTP server responded with code: ${code} + ${msg}`);
                    }
            }
        }
    }

    /**
     *  Send Mail directly
     * @param mail Mail object containing message, to/from etc.
     * Complete attributes reference: https://nodemailer.com/extras/mailcomposer/#e-mail-message-fields
     * @returns {Promise<void>}
     */
    async sendmail(mail: Options): Promise<void> {
        let recipients = Array();
        if (mail.to) {
            recipients = recipients.concat(this.getAddresses(mail.to));
        }

        if (mail.cc) {
            recipients = recipients.concat(this.getAddresses(mail.cc));
        }

        if (mail.bcc) {
            recipients = recipients.concat(this.getAddresses(mail.bcc));
        }

        const groups = this.groupRecipients(recipients);
        let from: string;
        let srcHost: string;
        let parsedEmail = EmailAddrParser.parseOneAddress(String(mail.from));
        if (parsedEmail !== null && parsedEmail.type === "mailbox") {
            from = parsedEmail.address;
            parsedEmail = EmailAddrParser.parseOneAddress(parsedEmail.address)
            if (parsedEmail !== null && parsedEmail.type === "mailbox") {
                srcHost = parsedEmail.domain;
                let message = await new MailComposer(mail).compile().build();
                if (this.dkimEnabled) {
                    // eslint-disable-next-line new-cap
                    const signature = DKIMSign(message, {
                        privateKey: this.dkimPrivateKey,
                        keySelector: this.dkimKeySelector,
                        domainName: srcHost
                    });
                    message = Buffer.from(signature + CRLF + message, 'utf8');
                }
                // eslint-disable-next-line guard-for-in
                for (let domain in groups) {
                    try {
                        await this.sendToSMTP(domain, srcHost, from, groups[domain], message.toString());
                    }
                    catch (ex) {
                        console.error(`Could not send email to ${domain}: ${ex}`);
                    }
                }
            }
        }
    }
}

export { MailDove }