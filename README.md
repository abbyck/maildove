# MailDove 🕊️✉️
<p>Send emails using Node.js!</p>

Maildove is a Node.js project written in TypeScript for handling email exchanges. The project includes utilities for managing email addresses and logging functionalities.

## Table of Contents
- [Maildove](#maildove)
  - [Table of Contents](#table-of-contents)
  - [Overview](#overview)
  - [Features](#features)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Usage](#usage)
    - [Logging](#logging)
    - [Maildove](#maildove)
  - [Testing](#testing)
  - [Project Structure](#project-structure)
  - [Contributing](#contributing)
  - [License](#license)

## Overview

Maildove is a project designed to manage email exchanges efficiently. It prioritizes connections based on a sorted list of mail exchanges and stops attempting connections once a successful connection is made.

## Features

- Sequential connection attempts to prioritized mail exchanges.
- Comprehensive logging capabilities.
- Utilities for handling and validating email addresses.

## Prerequisites

- Node.js (version 14.x or higher)
- npm (version 6.x or higher)
- Clean IP address, if you want your emails to be delivered (not listed in any of the IP reputation lists)
- Preferably, TLS configured, so that the entire exchange happens securely.

## Installation

To install the project, follow these steps:

Install via npm:

```sh
npm install maildove
```

## Usage

You can import and use maildove to send emails to an SMTP server without needing to pay for expensive mail relays, provided that you follow the best practices improve your email deliverability.

```javascript
const maildove = require("../lib/maildove");

const mailDove = new maildove.MailDove({
    // config options
});

mailDove
  .sendmail({
    from: "abhi@abhi.xyz",
    to: "abhinavkrishna@gmail.com, bee@abhy.com, hello@google.com",
    subject: `You have a message from `,
    html: `hiii ${Math.floor((Math.random() * 100) + 1)}`,
  })
  .then((successfulDomains) => {
    console.log(`RET: Message sent to ${successfulDomains}`);
  })
  .catch((ex) => {
    console.log(`ERR: ${ex}`);
  })

```

## License

This project is licensed under the MIT License. See the LICENSE file for details.