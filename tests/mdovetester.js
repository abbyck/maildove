const maildove = require("../lib/maildove");

const mailDove = new maildove.MailDove({
    smtpHost: "localhost",
    smtpPort: 2500
});

mailDove
  .sendmail({
    from: "abhi@abhi.xyz",
    to: "bob@testmail.com, joe@gmail.com, alice@testmail.com",
    subject: `You have a message from `,
    html: `hiii ${Math.floor((Math.random() * 100) + 1)}`,
  })
  .then((val) => {
    console.log(`RET: Message sent to ${val} `);
  })
  .catch((ex) => {
    console.log(`ERR: ${ex}`);
  })
