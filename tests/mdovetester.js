const maildove = require("../lib/maildove");

const mailDove = new maildove.MailDove({
  smtpPort: 2500,
  smtpHost: "localhost",
});

mailDove
  .sendmail({
    from: "abhi@abhi.xyz",
    to: "test@testmail.com",
    subject: `You have a message from `,
    html: `hiii ${Math.floor((Math.random() * 100) + 1)}`,
  })
  .then((val) => {
    console.log(`Message sent successfully. Promise resolved val: ${ val}`);
  })
  .catch((ex) => {
    console.log(`Could not sent email from, ${ex.code}`);
  })
