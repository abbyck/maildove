import { promises } from 'dns';
import { connect, createSecureContext } from 'tls';
import { createConnection, Socket } from 'net';
import { DKIMSign } from 'dkim-signer';
import { Options } from 'nodemailer/lib/mailer';
import { AddressUtils } from './address-utils';
import MailComposer from 'nodemailer/lib/mail-composer';
import EmailAddrParser from 'email-addresses';


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
    data = '';
    step = 0;
    queue: string[] = [];
    parts: string[];
    cmd: string;
    upgraded = false;
    isUpgradeInProgress = false;
    sock: Socket;
    message = '';
    resolvedMX: MXRecord[] = [];


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
            this.resolvedMX.push({ exchange: this.smtpHost, priority: 1 });
            return this.resolvedMX;
        }
        try {
            this.resolvedMX = await resolver.resolveMx(domain);
            this.resolvedMX.sort(function (a, b) {
                return a.priority - b.priority;
            });
            return this.resolvedMX;
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
    sendToSMTP(domain: string, srcHost: string, from: string, recipients: string[], body: string): Promise<unknown> { 
        return new Promise((resolve, reject) => {
            this.resolveMX(domain).then(MXRecord=> {
                const resolvedMX = MXRecord;
                console.info('Resolved mx list:', resolvedMX);
                let exchangeIndex: number;
                // eslint-disable-next-line @typescript-eslint/no-shadow
                const tryConnect = (exchangeIndex) => {
                    if (exchangeIndex >= resolvedMX.length) {
                        throw Error(`Could not connect to any SMTP server for ${domain}`);
                    }

                    this.sock = createConnection(this.smtpPort, resolvedMX[exchangeIndex].exchange);

                    this.sock.on('error', function (err) {
                        console.error('Error on connectMx for: ', resolvedMX[exchangeIndex], err);
                        tryConnect(++exchangeIndex);
                    });

                    
                    this.sock.on('connect', () => {
                        console.debug('MX connection created: ', resolvedMX[exchangeIndex].exchange);
                        this.sock.removeAllListeners('error');
                        return this.sock;
                    });
                };

                tryConnect(0);


                this.sock.setEncoding('utf8');

                this.sock.on('data', (chunk) => {
                    this.data += chunk;
                    this.parts = this.data.split(CRLF);
                    const partsLength = this.parts.length - 1;
                    for (let i = 0, len = partsLength; i < len; i++) {
                        this.onLine(this.parts[i], domain, srcHost, body, exchangeIndex);
                    }
                    this.data = this.parts[this.parts.length - 1];
                });

                this.sock.on('error', (err: Error) => {
                    throw Error(`Failed to connect to ${domain}: ${err}`);
                });

            
                this.queue.push('MAIL FROM:<' + from + '>');
                const recipientsLength = recipients.length;
                for (let i = 0; i < recipientsLength; i++) {
                    this.queue.push('RCPT TO:<' + recipients[i] + '>');
                }
                this.queue.push('DATA');
                this.queue.push('QUIT');
                this.queue.push('');
            });
        });
        
    }

    writeToSocket = (s: string, domain: string) => {
        console.debug(`SEND ${domain}> ${s}`);
        this.sock.write(s + CRLF);
    }

    onLine(line: string, domain: string, srcHost: string, body: string, exchangeIndex: number) {
        console.debug('RECV ' + domain + '>' + line);

        this.message += line + CRLF;

        if (line[3] === ' ') {
            // 250-information dash is not complete.
            // 250 OK. space is complete.
            const lineNumber = parseInt(line.substr(0, 3));
            this.response(lineNumber, this.message, domain, srcHost, body, exchangeIndex);
            this.message = '';
        }
    }

    response(code: number, msg: string, domain: string, srcHost: string, body: string, exchangeIndex: number) {
        switch (code) {
            case smtpCodes.ServiceReady:
                //220   on server ready
                if (this.isUpgradeInProgress === true) {
                    this.sock.removeAllListeners('data');
                    const original = this.sock;
                    original.pause();
                    const opts = {
                        socket: this.sock,
                        host: this.resolvedMX[exchangeIndex].exchange,
                        rejectUnauthorized: this.rejectUnauthorized,
                    }
                    if (this.startTLS) {
                        opts["secureContext"] = createSecureContext({
                            cert: this.tls.cert,
                            key: this.tls.key,
                        });
                    }
                    this.sock = connect(opts, () => {
                        this.sock.on('data', (chunk) => {
                            this.data += chunk;
                            this.parts = this.data.split(CRLF);
                            const partsLength = this.parts.length - 1;
                            for (let i = 0, len = partsLength; i < len; i++) {
                                this.onLine(this.parts[i], domain, srcHost, body, exchangeIndex);
                            }
                            this.data = this.parts[this.parts.length - 1];
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
                    // check for ESMTP/ignore-case
                    if (/\besmtp\b/i.test(msg)) {
                        // TODO: determine AUTH type; auth consolein, auth crm-md5, auth plain
                        this.cmd = 'EHLO';
                    } else {
                        this.upgraded = true;
                        this.cmd = 'HELO';
                    }
                    this.writeToSocket(`${this.cmd} ${srcHost}`, domain);
                    break;
                }
            case smtpCodes.Bye:
                // BYE
                this.sock.end();
                console.info('message sent successfully', msg);
                break;
            case smtpCodes.AuthSuccess: // Verify OK
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
                        console.debug('No STARTTLS support or ignored, continuing');
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
                    throw Error(`SMTP server responded with code: ${code} + ${msg}`);
                }
        }
    };

    /**
     *  Send Mail directly
     * @param mail Mail object containing message, to/from etc.
     * Complete attributes reference: https://nodemailer.com/extras/mailcomposer/#e-mail-message-fields
     * @returns {Promise<void>}
     */
    public async sendmail(mail: Options): Promise<void> {
        let recipients: string[] = [];
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
        let from: string;
        let srcHost: string;
        let parsedEmail = EmailAddrParser.parseOneAddress(String(mail.from));
        if (parsedEmail !== null && parsedEmail.type === 'mailbox') {
            from = parsedEmail.address;
            parsedEmail = EmailAddrParser.parseOneAddress(parsedEmail.address);
            if (parsedEmail !== null && parsedEmail.type === 'mailbox') {
                srcHost = parsedEmail.domain;
                let message = await new MailComposer(mail).compile().build();
                if (this.dkimEnabled) {
                    // eslint-disable-next-line new-cap
                    const signature = DKIMSign(message, {
                        privateKey: this.dkimPrivateKey,
                        keySelector: this.dkimKeySelector,
                        domainName: srcHost,
                    });
                    message = Buffer.from(signature + CRLF + message, 'utf8');
                }
                // eslint-disable-next-line guard-for-in
                for (const domain in groups) {
                    try {
                        await this.sendToSMTP(domain, srcHost, from, groups[domain], message.toString());
                    } catch (ex) {
                        console.error(`Could not send email to ${domain}: ${ex}`);
                    }
                }
            }
        }
    }
}

export { MailDove };
