const maildove = require("../lib/maildove");

const mailDove = new maildove.MailDove({

});

mailDove
  .sendmail({
    from: "abhi@abhi.xyz",
    to: "bob@testmail.com, abhinavkrishna2000@gmail.com, alice@testmail.com",
    subject: `You have a message from `,
    html: `hiii ${Math.floor((Math.random() * 100) + 1)}`,
  })
  .then((val) => {
    console.log(`RET: ${val} `);
  })
  .catch((ex) => {
    console.log(`ERR: ${ex}`);
  })
