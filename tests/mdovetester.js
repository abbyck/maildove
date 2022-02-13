const maildove = require("../lib/maildove");

const mailDove = new maildove.MailDove({
  smtpPort: 2500,
  smtpHost: "localhost",
});

mailDove
  .sendmail({
    from: "abhi@abhi.in",
    to: "abhinavkrishna2000@gmail.com",
    subject: `You have a message from abby`,
    html: `hiii ${Math.floor((Math.random() * 100) + 1)}`,
  })
  .then((val) => {
    console.log(`Message sent successfully`);
  })
  .catch((ex) => {
    console.log(`Could not sent email from, ${ex.stack}`);
  })
