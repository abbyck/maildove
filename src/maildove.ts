import { promises } from 'dns';
import { connect, createSecureContext } from 'tls';
import { createConnection, Socket } from 'net';
import { DKIMSign } from 'dkim-signer';
import { Options } from 'nodemailer/lib/mailer';
import { AddressUtils } from './address-utils';
import MailComposer from 'nodemailer/lib/mail-composer';
import EmailAddrParser from 'email-addresses';
import logger from './logging';


const resolver = new promises.Resolver();
const addressUtils = new AddressUtils();
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
    exchange: string;
    priority: number;
}

interface tlsInterface {
    key: string;
    cert: string;
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
    step = 0;
    queue: string[] = [];
    // TODO: May crash in multi domain scenario
    // Where one of the domains is not TLS capable.
    upgraded = false;
    isUpgradeInProgress = false;
    sock: Socket;


    constructor(options: MailDoveOptions) {
        this.dkimEnabled = options.dkimEnabled || false;
        this.dkimKeySelector = options.dkimKeySelector || '';
        this.dkimPrivateKey = options.dkimPrivateKey || '';
        this.smtpPort = options.smtpPort || 25;
        this.smtpHost = options.smtpHost;
        this.startTLS = options.startTLS || false;
        this.rejectUnauthorized = options.rejectUnauthorized || true;
        this.tls = options.tls || { key: '', cert: '' };
    }

    /**
     * Resolve MX records by domain.
     * @param {string} domain
     * @returns {Promise<MXRecord[]>}
     */
    async resolveMX(domain: string): Promise<MXRecord[]> {
        if (this.smtpHost !== '' && this.smtpHost) {
            return ([{ exchange: this.smtpHost, priority: 1 }])
        }
        try {
            const resolvedMX = await resolver.resolveMx(domain);
            resolvedMX.sort(function (a, b) {
                return a.priority - b.priority;
            });
            return resolvedMX;
        } catch (ex) {
            throw Error(`Failed to resolve MX for ${domain}: ${ex}`);
        }
    }



    // /***
    //  * Send email using SMTP.
    //  * @param {string}  domain    `to` address.
    //  * @param {string}  srcHost   Source hostname.
    //  * @param {string}  from      Source from address.
    //  * @param {string[]}recipients    Recipients list.
    //  * @param {string}  body      Email body
    //  * @returns {Promise<void>}
    //  */
    async sendToSMTP(domain: string, srcHost: string, from: string, recipients: string[], body: string): Promise<any> {
        const resolvedMX = await this.resolveMX(domain)
        logger.log("debug", "Resolved MX %O", resolvedMX);

        await new Promise((resolve, reject) => {
            let connectedExchange: string;

            for (const mx of resolvedMX) {
                this.sock = createConnection(this.smtpPort, mx.exchange);

                // eslint-disable-next-line no-loop-func
                this.sock.on('connect', () => {
                    logger.info('Connected to exchange: ' + mx.exchange);
                    connectedExchange = mx.exchange;
                    this.sock.removeAllListeners('error');
                });

                this.sock.on('error', function (err) {
                    logger.error(`Could not connect to exchange ${mx}, ${err}`);
                });
            }

            this.sock.setEncoding('utf8');

            this.sock.on('data', (chunk) => {
                // Convert RCVD to an array 
                const received = chunk.toString().split(CRLF);
                for (const line of received) {
                    this.parseInputAndRespond(line, domain, srcHost, body, connectedExchange, resolve);
                }
            });

            this.sock.on('error', (err: Error) => {
                reject(`Failed to connect to ${domain}: ${err}`);
                return;
            });

            // Build rest of the SMTP exchange queue
            this.queue.push('MAIL FROM:<' + from + '>');

            const recipientsLength = recipients.length;
            for (let i = 0; i < recipientsLength; i++) {
                this.queue.push('RCPT TO:<' + recipients[i] + '>');
            }
            logger.log("verbose", "RCPTS %O", recipients);

            this.queue.push('DATA');
            this.queue.push('QUIT');
            this.queue.push('');
        })

        return domain
    }

    writeToSocket = (s: string, domain: string) => {
        logger.debug(`SEND ${domain}> ${s}`);
        this.sock.write(s + CRLF);
    }

    parseInputAndRespond(line: string, domain: string, srcHost: string, body: string, connectedExchange: string, resolve) {
        logger.debug('RECV ' + domain + '>' + line);

        const message = line + CRLF;

        if (line[3] === ' ') {
            // 250 - Requested mail action okay, completed.
            const lineNumber = parseInt(line.substring(0, 4));
            this.handleResponse(lineNumber, message, domain, srcHost, body, connectedExchange, resolve);
        }
    }

    handleResponse(code: number, msg: string, domain: string, srcHost: string, body: string, connectedExchange: string, resolve) {
        switch (code) {
            case smtpCodes.ServiceReady:
                //220 - On <domain> Service ready
                // Check if TLS upgrade is in progress
                if (this.isUpgradeInProgress === true) {
                    this.sock.removeAllListeners('data');
                    const original = this.sock;
                    // Pause the original socket and copy some options from it
                    // to create a new socket.
                    original.pause();
                    const opts = {
                        socket: this.sock,
                        host: connectedExchange,
                        rejectUnauthorized: this.rejectUnauthorized,
                    }
                    if (this.startTLS) {
                        opts["secureContext"] = createSecureContext({
                            cert: this.tls.cert,
                            key: this.tls.key,
                        });
                    }
                    // Connect to the new socket with the copied options + secureContext.
                    this.sock = connect(opts, () => {
                        this.sock.on('data', (chunk) => {
                            // Convert RCVD to an array 
                            const received = chunk.toString().split(CRLF);
                            for (const line of received) {
                                this.parseInputAndRespond(line, domain, srcHost, body, connectedExchange, resolve);
                            }
                        });
                        this.sock.removeAllListeners('close');
                        this.sock.removeAllListeners('end');
                    });

                    this.sock.on('error', function (err: Error) {
                        console.warn('Could not upgrade to TLS:', err, 'Falling back to plaintext');
                    });
                    // TLS Unsuccessful -> Resume plaintext connection
                    original.resume();
                    this.upgraded = true;
                    this.writeToSocket('EHLO ' + srcHost, domain);
                    break;
                } else {
                    let helloCommand: string;
                    // check for ESMTP/ignore-case
                    if (/\besmtp\b/i.test(msg)) {
                        // TODO: determine AUTH type for relay; auth consolein, auth crm-md5, auth plain
                        helloCommand = 'EHLO';
                    } else {
                        // SMTP Only, hence don't check for STARTTLS
                        this.upgraded = true;
                        helloCommand = 'HELO';
                    }
                    this.writeToSocket(`${helloCommand} ${srcHost}`, domain);
                    break;
                }
            case smtpCodes.Bye:
                // BYE
                this.sock.end();
                // Reset step counter
                this.step = 0;
                // Clear the command queue
                // https://es5.github.io/x15.4.html#x15.4
                // whenever the length property is changed, every property
                // whose name is an array index whose value is not smaller 
                // than the new length is automatically deleted
                this.queue.length = 0;

                resolve(domain);
                return;

            case smtpCodes.AuthSuccess: // AUTH-Verify OK
            case smtpCodes.OperationOK: // Operation OK
                if (this.upgraded !== true) {
                    // check for STARTTLS/ignore-case
                    if (/\bSTARTTLS\b/i.test(msg) && this.startTLS) {
                        console.debug('Server supports STARTTLS, continuing');
                        this.writeToSocket('STARTTLS', domain);
                        this.isUpgradeInProgress = true;
                        break;
                    } else {
                        this.upgraded = true;
                        logger.debug('No STARTTLS support or ignored, continuing');
                    }
                }
                this.writeToSocket(this.queue[this.step], domain);
                this.step++;
                break;

            case smtpCodes.ForwardNonLocalUser:
                // User not local; will forward.
                if (this.step === this.queue.length - 1) {
                    console.info('OK:', code, msg);
                    return;
                }
                this.writeToSocket(this.queue[this.step], domain);
                this.step++;
                break;

            case smtpCodes.StartMailBody:
                // Start mail input
                // Inform end by `<CR><LF>.<CR><LF>`
                this.writeToSocket(body, domain);
                this.writeToSocket('', domain);
                this.writeToSocket('.', domain);
                break;

            case smtpCodes.ServerChallenge:
                // Send consolein details [for relay]
                // TODO: support login.
                // writeToSocket(login[loginStep]);
                // loginStep++;
                break;

            default:
                if (code >= smtpCodes.NegativeCompletion) {
                    console.error('SMTP server responds with error code', code);
                    this.sock.end();
                    resolve(`SMTP server responded with code: ${code} + ${msg}`);
                }
        }
    };

    /**
     *  Send Mail directly
     * @param mail Mail object containing message, to/from etc.
     * Complete attributes reference: https://nodemailer.com/extras/mailcomposer/#e-mail-message-fields
     * @returns {Promise<string[]>}
     */
    public async sendmail(mail: Options): Promise<string[]> {
        // TODO: return void on success or error
        let recipients: string[] = [];
        const successOutboundRecipients: string[] = [];

        if (mail.to) {
            recipients = recipients.concat(addressUtils.getAddressesFromString(String(mail.to)));
        }

        if (mail.cc) {
            recipients = recipients.concat(addressUtils.getAddressesFromString(String(mail.cc)));
        }

        if (mail.bcc) {
            recipients = recipients.concat(addressUtils.getAddressesFromString(String(mail.bcc)));
        }

        const groups = addressUtils.groupRecipientsByDomain(recipients);

        const parsedEmail = EmailAddrParser.parseOneAddress(String(mail.from));

        if (parsedEmail?.type === 'mailbox') {
            let message = await new MailComposer(mail).compile().build();
            if (this.dkimEnabled) {
                // eslint-disable-next-line new-cap
                const signature = DKIMSign(message, {
                    privateKey: this.dkimPrivateKey,
                    keySelector: this.dkimKeySelector,
                    domainName: parsedEmail.domain,
                });
                message = Buffer.from(signature + CRLF + message, 'utf8');
            }

            // eslint-disable-next-line guard-for-in
            for (const domain in groups) {
                try {
                    logger.info(`DOMN: Group: ${groups[domain]}`)
                    successOutboundRecipients.push(
                        await this.sendToSMTP(domain, parsedEmail.domain,
                            parsedEmail.address, groups[domain], message.toString()));
                } catch (ex) {
                    logger.error(`Could not send email to ${domain}: ${ex}`);
                }
            }
        }
        if (!successOutboundRecipients.length) {
            throw "Could not send mails to any of the recipients"
        }
        return successOutboundRecipients;
    }
}

export { MailDove };
