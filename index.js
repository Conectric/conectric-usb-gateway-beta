const usb = require('usb')
const serialport = require('serialport');
const Readline = serialport.parsers.Readline;
const Joi = require('joi');
const cache = require('memory-cache-ttl');
const moment = require('moment');
const roundTo = require('round-to');

const conectricUsbGateway = {
    macAddress: undefined,
    parser: undefined,
    serialPort: undefined,
    contikiVersion: undefined,
    conectricVersion: undefined,

    BROADCAST_LOCAL_ADDRESS: 'ffff',
    BROADCAST_ALL_ADDRESS: '0000',

    PARITY_NONE: 'none',
    PARITY_ODD: 'odd',
    PARTITY_EVEN: 'even',

    STANDARD_HEADER: 0,
    EXTENDED_HEADER: 128,
    
    MESSAGE_TYPES: {
        '30': 'tempHumidity',
        '31': 'switch',
        '32': 'motion',
        '36': 'rs485Request',
        '37': 'rs485Response',
        '38': 'rs485ChunkRequest',
        '39': 'rs485ChunkResponse',
        '42': 'rs485ChunkEnvelopeResponse',
        '44': 'moisture',
        '45': 'tempHumidityLight',
        '46': 'tempHumidityAdc',
        '60': 'boot',
        '61': 'text',
        '70': 'rs485Config'
    },

    BROADCAST_MESSAGE_TYPES: [
        '30',
        '31',
        '32',
        '37',
        '39',
        '42',
        '44',
        '45',
        '46',
        '60',
        '61'
    ],

    TX_LED_DEFAULT_COLOR: '02', // Red
    RX_LED_DEFAULT_COLOR: '01', // Green
    ACTIVITY_LED_DEFAULT_COLOR: '04', // Yellow

    PARAM_SCHEMA: Joi.object().keys({
        onSensorMessage: Joi.func().required(),
        onGatewayReady: Joi.func().optional(),
        sendAdcWithLux: Joi.boolean().optional(),
        sendRawData: Joi.boolean().optional(),
        sendRawLux: Joi.boolean().optional(),
        sendBootMessages: Joi.boolean().optional(),
        sendStatusMessages: Joi.boolean().optional(),
        sendDecodedPayload: Joi.boolean().optional(),
        sendEventCount: Joi.boolean().optional(),
        useFahrenheitTemps: Joi.boolean().optional(),
        useMillisecondTimestamps: Joi.boolean().optional(),
        switchOpenValue: Joi.boolean().optional(),
        deDuplicateBursts: Joi.boolean().optional(),
        decodeTextMessages: Joi.boolean().optional(),
        debugMode: Joi.boolean().optional(),
        sendHopData: Joi.boolean().optional()
    }).required().options({
        allowUnknown: false
    }),

    TEXT_MESSAGE_SCHEMA: Joi.object().keys({
        message: Joi.string().min(1).max(250).required(),
        destination: Joi.string().length(4).required()
    }).required().options({
        allowUnknown: false
    }),

    RS485_MESSAGE_SCHEMA: Joi.object().keys({
        message: Joi.string().min(1).max(250).required(),
        destination: Joi.string().length(4).required(),
        hexEncodePayload: Joi.boolean().optional()
    }).required().options({
        allowUnknown: false
    }),

    RS485_CHUNKED_MESSAGE_SCHEMA: Joi.object().keys({
        chunkNumber: Joi.number().integer().min(0).required(),
        chunkSize: Joi.number().integer().min(1).required(),
        destination: Joi.string().length(4).required()
    }).required().options({
        allowUnknown: false
    }),

    RS485_CONFIG_MESSAGE_SCHEMA: Joi.object().keys({
        baudRate: Joi.number().valid(
            2400, 
            4800, 
            9600,
            19200
        ),
        parity: Joi.string().valid(
            'none',
            'odd',
            'even'
        ),
        stopBits: Joi.number().valid(
            1, 
            2
        ),
        bitMask: Joi.number().valid(
            7,
            8
        ),
        destination: Joi.string().length(4).required()
    }).required().options({
        allowUnknown: false
    }),

    LED_CONFIG_MESSAGE_SCHEMA: Joi.object().keys({
        destination: Joi.string().length(4).required(),
        sensorType: Joi.string().valid(
            'moisture',
            'motion',
            'switch',
            'tempHumidity',
            'tempHumidityLight'  
        ).required(),
        leds: Joi.object().keys({
            tx: Joi.boolean().required(),
            rx: Joi.boolean().required(),
            activity: Joi.boolean().required()
        }).required().options({
            allowUnknown: false
        }),
        deploymentLifetime: Joi.number().integer().min(0).required()
    }).required().options({
        allowUnknown: false
    }),

    IGNORABLE_MESSAGE_TYPES: [ '33', '34', '35' ],

    KNOWN_COMMANDS: [ 'DP', 'MR', 'SS', 'VER' ],

    runGateway: async function(params) {
        const validationResult = Joi.validate(params, conectricUsbGateway.PARAM_SCHEMA);

        if (validationResult.error) {
            console.error(validationResult.error.message);
            return;
        }

        // sendBootMessages is on by default
        if (! params.hasOwnProperty('sendBootMessages')) {
            params.sendBootMessages = true;
        }

        // sendDecodedPayload is on by default
        if (! params.hasOwnProperty('sendDecodedPayload')) {
            params.sendDecodedPayload = true;
        }

        // deDuplicateBursts is on by default
        if (! params.hasOwnProperty('deDuplicateBursts')) {
            params.deDuplicateBursts = true;
        }

        // decodeTextMessages is on by default
        if (! params.hasOwnProperty('decodeTextMessages')) {
            params.decodeTextMessages = true;
        }

        // Establish cache if needed.
        if (params.deDuplicateBursts) {
            cache.init({ ttl: 30, interval: 3, randomize: false });
        }

        conectricUsbGateway.params = params;

        conectricUsbGateway.handleUSBEvents();
        conectricUsbGateway.startGateway();
    },

    handleUSBEvents: () => {
        usb.on('attach', function(device) { 
            if (conectricUsbGateway.isConectricRouter(device)) {
                console.log('USB Router device attached.');
                setTimeout(conectricUsbGateway.startGateway, 200); 
            }
        });
        usb.on('detach', function(device) { 
            if (conectricUsbGateway.isConectricRouter(device)) {
                console.log('USB Router device removed.');
                setTimeout(conectricUsbGateway.startGateway, 100); 
            }
        });        
    },

    startGateway: async function () {
        try {
            await conectricUsbGateway.findRouterDevice();
            console.log(`Found USB router device at ${conectricUsbGateway.comName}.`);
        } catch(e) {
            console.log('Waiting for USB router device.');
            conectricUsbGateway.macAddress = undefined;
            conectricUsbGateway.parser = undefined;
            conectricUsbGateway.serialPort = undefined;
            conectricUsbGateway.conectricVersion = undefined;
            conectricUsbGateway.contikiVersion = undefined;
            return;
        }

        conectricUsbGateway.startSerial();
        conectricUsbGateway.parser = new Readline();
        conectricUsbGateway.serialPort.pipe(conectricUsbGateway.parser);

        conectricUsbGateway.serialPort.on('open', function() {
            console.log('Gateway opened.');
        });

        conectricUsbGateway.serialPort.on('close', function() {
            console.log('Gateway closed.');
        });

        conectricUsbGateway.parser.on('data', function(data) {
            if (data.startsWith('>') && conectricUsbGateway.conectricVersion && conectricUsbGateway.contikiVersion && conectricUsbGateway.macAddress) {
                // Found a message and we have started up properly.
                conectricUsbGateway.parseMessage(`${data.substring(1)}`);
            } else if (data.startsWith('MR:')) {
                // Found mac address.
                conectricUsbGateway.macAddress = `${data.substring(3)}`;
                console.log(`USB router mac address is ${conectricUsbGateway.macAddress}.`);
            } else if (data === 'DP:Ok') {
                // Dump buffer was acknowledged OK.
                console.log('Switched gateway to dump payload mode.');
            } else if (data === 'SS:Ok') {
                // Sink was acknowledged OK.
                console.log('Switched gateway to sink mode.');
                
                // Notify caller gateway is ready, if interested.
                if (conectricUsbGateway.params.onGatewayReady) {
                    conectricUsbGateway.params.onGatewayReady();
                }
            } else if (data.toLowerCase().startsWith('ver:contiki')) {
                conectricUsbGateway.contikiVersion = data.substring(12);
                console.log(`USB router Contiki version: ${conectricUsbGateway.contikiVersion}`);
            } else if (data.toLowerCase().startsWith('ver:conectric-v')) {
                conectricUsbGateway.conectricVersion = data.substring(15);
                console.log(`USB router Conectric version: ${conectricUsbGateway.conectricVersion}`);
            } else {
                if (! conectricUsbGateway.KNOWN_COMMANDS.includes(data)) {
                    if (conectricUsbGateway.params.debugMode) {
                        console.log(`Unprocessed: ${data}`);
                    }
                }
            }
        });
        
        setTimeout(function() {
            conectricUsbGateway.serialPort.write('DP\n');
            setTimeout(function() {
                conectricUsbGateway.serialPort.write('V');
                conectricUsbGateway.serialPort.write('E');
                conectricUsbGateway.serialPort.write('R\n');
                setTimeout(function() {
                    conectricUsbGateway.serialPort.write('MR\n');
                    setTimeout(function() {
                        conectricUsbGateway.serialPort.write('SS\n');
                    }, 500);        
                }, 500);
            }, 500);
            
            // Original:
            //conectricUsbGateway.serialPort.write('DP\nMR\nVER\nSS\n');
        }, 1500);
    },

    isConectricRouter: (device) => {
        const descriptor = device.deviceDescriptor;
        if (descriptor) {
            return (descriptor.idVendor && descriptor.idVendor === 1027 && descriptor.idProduct && descriptor.idProduct === 24597);
        }

        return false;
    },

    isBroadcastMessageType: (messageType) => {
        return conectricUsbGateway.BROADCAST_MESSAGE_TYPES.includes(messageType);
    },

    findRouterDevice: () => {
        return new Promise((resolve, reject) => {
            serialport.list((err, ports) => {
                for (let n = 0; n < ports.length; n++) {
                    const port = ports[n];
                    const lowerPortName = port.comName.toLowerCase();

                    if (port.manufacturer && port.manufacturer === 'FTDI' && (
                        lowerPortName.indexOf('usbserial-') !== -1 || 
                        lowerPortName.indexOf('ttyusb') !== -1 ||
                        lowerPortName.indexOf('com') !== -1)
                    ) {
                        conectricUsbGateway.comName = port.comName;
                        return resolve(port.comName);
                    }
                }

                // No suitable port found.
                conectricUsbGateway.comName = null;
                return reject();
            });
        });
    },

    startSerial: () => {
        conectricUsbGateway.serialPort = new serialport(conectricUsbGateway.comName, {
            baudRate:  230400
        });

        return conectricUsbGateway.serialPort;
    },

    hexEncode: (message) => {
        let encodedMessage = '';

        for (let n = 0; n < message.length; n++) {
            let encodedChar = message.charCodeAt(n).toString(16);

            if (encodedChar.length === 1) {
                encodedChar = `0${encodedChar}`;
            }

            encodedMessage = `${encodedMessage}${encodedChar}`;
        }

        return encodedMessage;
    },

    hexDecode: (message) => {
        let decodedMessage = '';

        for (let n = 0; n < message.length; n += 2) {
            decodedMessage = `${decodedMessage}${String.fromCharCode(parseInt(message.substr(n, 2), 16))}`;
        }

        return decodedMessage;
    },

    calculateTemperature: (tempRaw) => {
        const temperature = roundTo((-46.85 + ((parseInt(tempRaw, 16) / 65536) * 175.72)), 2); // C

        if (conectricUsbGateway.params.useFahrenheitTemps) {
            return {
                temperature: roundTo(((temperature * (9 / 5)) + 32), 2), // F
                temperatureUnit: 'F'
            }
        } else {
            return {
                temperature,
                temperatureUnit: 'C'
            }
            message.payload.temperatureUnit = 'C';
        }
    },

    calculateHumidity: (humidityRaw) => {
        return roundTo((-6 + (125 * (parseInt(humidityRaw, 16) / 65536))), 2); // percentage
    },

    sendTextMessage: (params) => {
        const validationResult = Joi.validate(params, conectricUsbGateway.TEXT_MESSAGE_SCHEMA);

        if (validationResult.error) {
            console.error(validationResult.error.message);
            return false;
        }

        let encodedPayload = conectricUsbGateway.hexEncode(params.message);

        // length:
        // 1 for the message type
        // 1 for the length
        // 2 for the destination
        // 1 for the reserved part
        // 1 for each letter in the message
        let msgLen = 5 + params.message.length;
        let hexLen = msgLen.toString(16);

        if (hexLen.length === 1) {
            hexLen = `0${hexLen}`;
        }

        let outboundMessage = `<${hexLen}61${params.destination}01${encodedPayload}`;
                
        if (conectricUsbGateway.params.debugMode) {
            console.log(`Outbound text message: ${outboundMessage}`);
        }

        conectricUsbGateway.serialPort.write(`${outboundMessage}\n`);

        return true;
    },

    _sendRS485Message: (params) => {
        // hexEncodePayload is on by default
        if (! params.hasOwnProperty('hexEncodePayload')) {
            params.hexEncodePayload = true;
        }

        let encodedPayload;
        
        if (params.hexEncodePayload) {
            if (conectricUsbGateway.params.debugMode) {
                console.log('Hex encoding outbound RS485 request message.');
            }
            encodedPayload = conectricUsbGateway.hexEncode(params.message);
        } else {
            encodedPayload = params.message;
        }

        // length:
        // 1 for the message type
        // 1 for the length
        // 2 for the destination
        // 1 for the reserved part
        // 1 for each letter in the message if encoding
        let msgLen = 5 + (params.hexEncodePayload ? params.message.length : params.message.length / 2);
        let hexLen = msgLen.toString(16);

        if (hexLen.length === 1) {
            hexLen = `0${hexLen}`;
        }

        let outboundMessage = `<${hexLen}${params.msgCode}${params.destination}01${encodedPayload}`;
                
        if (conectricUsbGateway.params.debugMode) {
            console.log(`Outbound RS485 request: ${outboundMessage}`);
        }

        conectricUsbGateway.serialPort.write(`${outboundMessage}\n`);

        return true;
    },

    sendRS485ChunkRequest: (params) => {
        const validationResult = Joi.validate(params, conectricUsbGateway.RS485_CHUNKED_MESSAGE_SCHEMA);

        if (validationResult.error) {
            console.error(validationResult.error.message);
            return false;
        }
        
        params.msgCode = 38;

        let chunkNumberHex = params.chunkNumber.toString(16);

        if (chunkNumberHex.length === 1) {
            chunkNumberHex = `0${chunkNumberHex}`;
        }

        let chunkSizeHex = params.chunkSize.toString(16);

        if (chunkSizeHex.length === 1) {
            chunkSizeHex = `0${chunkSizeHex}`;
        }

        params.message = `${chunkNumberHex}${chunkSizeHex}`;
        params.hexEncodePayload = false;
        return conectricUsbGateway._sendRS485Message(params);
    },

    sendLEDConfigMessage: (params) => {
        const validationResult = Joi.validate(params, conectricUsbGateway.LED_CONFIG_MESSAGE_SCHEMA);

        if (validationResult.error) {
            console.error(validationResult.error.message);
            return false;
        }

        params.msgCode = '1c'; // set here

        let destinationSensorType;

        switch (params.sensorType) {
            case 'moisture':
                destinationSensorType = '59';
                break;
            case 'motion':
                destinationSensorType = '04';
                break;  
            case 'switch':
                destinationSensorType = '05';
                break;      
            case 'tempHumidity':
                destinationSensorType = '29';
                break;
            case 'tempHumidityLight':
                destinationSensorType = '5A';
                break;
        }

        const txLED = params.leds.tx === true ? conectricUsbGateway.TX_LED_DEFAULT_COLOR : '00';
        const rxLED = params.leds.rx === true ? conectricUsbGateway.RX_LED_DEFAULT_COLOR : '00';
        const activityLED = params.leds.activity === true ? conectricUsbGateway.ACTIVITY_LED_DEFAULT_COLOR : '00';
        const deploymentLifetime = params.deploymentLifetime.toString(16);

        let msg = `${params.msgCode}${params.destination}01${deploymentLifetime}c108${destinationSensorType}07010204${txLED}${rxLED}${activityLED}00`

        let msgLen = 1 + (msg.length / 2); // 1 is the length byte.
        let hexLen = msgLen.toString(16);

        if (hexLen.length === 1) {
            hexLen = `0${hexLen}`;
        }

        let outboundMessage = `<${hexLen}${msg}`;
        if (conectricUsbGateway.params.debugMode) {
            console.log(`Outbound LED config message: ${outboundMessage}`);
        }

        conectricUsbGateway.serialPort.write(`${outboundMessage}\n`);      
        return true;
    },

    sendRS485Request: (params) => {
        const validationResult = Joi.validate(params, conectricUsbGateway.RS485_MESSAGE_SCHEMA);

        if (validationResult.error) {
            console.error(validationResult.error.message);
            return false;
        }

        params.msgCode = 36;
        return conectricUsbGateway._sendRS485Message(params);
    },

    sendRS485ConfigMessage: (params) => {
        const validationResult = Joi.validate(params, conectricUsbGateway.RS485_CONFIG_MESSAGE_SCHEMA);

        if (validationResult.error) {
            console.error(validationResult.error.message);
            return false;
        }   

        let baudRate;

        switch (params.baudRate) {
            case 2400:
                baudRate = '00';
                break;
            case 4800:
                baudRate = '01';
                break;
            case 9600:
                baudRate = '02';
                break;
            case 19200:
                baudRate = '03';
                break;
        }

        let parity;

        switch (params.parity) {
            case conectricUsbGateway.PARITY_NONE:
                parity = '00';
                break;
            case conectricUsbGateway.PARITY_ODD:
                parity = '01';
                break;
            case conectricUsbGateway.PARITY_EVEN:
                parity = '02';
                break;
        }

        const stopBits = (params.stopBits === 1 ? '00' : '01');
        const bitMask = (params.bitMask === 8 ? '00' : '01');

        let outboundMessage = `<0970${params.destination}01${baudRate}${parity}${stopBits}${bitMask}`;

        if (conectricUsbGateway.params.debugMode) {
            console.log(`Outbound RS485 config message: ${outboundMessage}`);
        }

        conectricUsbGateway.serialPort.write(`${outboundMessage}\n`);
        return true;
    },

    parseMessage: (data) => {
        const fullMessage = data;

        if (conectricUsbGateway.params.debugMode) {
            console.log(fullMessage);
        }

        // Chop off the last 4 which are CRC.
        data = data.substring(0, data.length - 4);

        if (conectricUsbGateway.params.debugMode) {
            console.log(`Removed CRC from data, leaving: ${data}`);
        }

        // Get to the message type value first so we can drop message
        // types that are not intended for the end user.
        const hexHeader = parseInt(data.substring(0, 2), 16);

        const headerLength = (hexHeader & 31); // 0x1F
        const headerType = (hexHeader & 128); // 0x80
        const payloadType = (hexHeader & 96); // 0x60

        // Right now we don't support the extended header, and 
        // we only support the simple payload.
        if (headerType !== 0) {
            if (conectricUsbGateway.params.debugMode) {
                console.log(`Dropping message "${fullMessage}" as messages with extended headers are unsupported in this version.`);
            }

            return;
        }

        if (payloadType !== 32) {
            if (conectricUsbGateway.params.debugMode) {
                console.log(`Dropping message "${fullMessage}" as this payload type is unsupported in this version.`);
            }

            return;
        }

        const messageType = data.substring(2 + (headerLength * 2), 4 + (headerLength * 2));

        if (conectricUsbGateway.IGNORABLE_MESSAGE_TYPES.includes(messageType)) {
            // Drop this message and do no more work on it.
            if (conectricUsbGateway.params.debugMode) {
                console.log(`Dropping message "${fullMesage}" as it is ignorable.`);
            }
            
            return;
        }

        const messageTypeString = conectricUsbGateway.MESSAGE_TYPES[messageType];

        if (! messageTypeString || messageTypeString.length === 0) {
            if (conectricUsbGateway.params.debugMode) {
                console.log(`Ignoring unknown message type "${messageType}".`);
            }

            return;
        }

        const sourceAddr = data.substring(8, 12);
        const sequenceNumber = parseInt(data.substring(2, 4), 16);
        const payloadLength = parseInt(data.substring(0 + (headerLength * 2), 2 + (headerLength * 2)), 16);
        const battery = parseInt(data.substring(4 + (headerLength * 2), 6 + (headerLength * 2)), 16) / 10;
        const messageData = data.substring(6 + (headerLength * 2));

        // Check if we have cached this message before
        if (conectricUsbGateway.params.deDuplicateBursts) {
            const cacheKey = `${sourceAddr}${sequenceNumber}${messageData}`;

            if (! cache.get(cacheKey)) {
                // We have not dealt with this burst before.
                cache.set(cacheKey, true);
            } else {
                // We have seen this recently and processed it so drop it.
                if (conectricUsbGateway.params.debugMode) {
                    console.log(`Dropping message "${data}", already processed message from this burst.`);
                }

                return;
            }
        }
        
        const message = {
            type: messageTypeString,
            payload: {},
            sensorId: sourceAddr,
            sequenceNumber
        };

        message.timestamp= (conectricUsbGateway.params.useMillisecondTimestamps ? moment().valueOf() : moment().unix());

        if (conectricUsbGateway.isBroadcastMessageType(messageType)) {
            // Broadcast message detected add extra fields.
            if (conectricUsbGateway.params.debugMode) {
                console.log(`Message type "${messageType}" is a broadcast message type.`);
            }

            if (conectricUsbGateway.params.sendHopData) {
                message.numHops = parseInt(data.substring(4, 6), 16);
                message.maxHops = parseInt(data.substring(6, 8), 16);
            }
        } else if (conectricUsbGateway.params.debugMode) {
            console.log(`Message type "${messageType}" is not a broadcast message type.`);
        }

        if (conectricUsbGateway.params.sendRawData) {
            message.rawData = fullMessage;
        }

        if (! conectricUsbGateway.params.sendDecodedPayload) {
            delete(message.payload);
        } else {
            switch (messageTypeString) {
                case 'tempHumidity':
                    let tempRaw
                    let humidityRaw

                    if (messageData.length === 8) {
                        // Older style
                        tempRaw = messageData.substring(0, 4);
                        humidityRaw = messageData.substring(4);
                    } else {
                        // Newer style
                        tempRaw = messageData.substring(10, 14);
                        humidityRaw = messageData.substring(14);

                        if (conectricUsbGateway.params.sendEventCount) {
                            message.payload.eventCount = parseInt(messageData.substring(2, 10), 16)
                        }    
                    }

                    message.payload = { 
                        ...message.payload, 
                        battery,
                        ...conectricUsbGateway.calculateTemperature(tempRaw), 
                        humidity: conectricUsbGateway.calculateHumidity(humidityRaw)
                    };

                    break;
                case 'tempHumidityAdc': 
                    {
                        message.payload.battery = battery;

                        if (conectricUsbGateway.params.sendEventCount) {
                            message.payload.eventCount = parseInt(messageData.substring(2, 10), 16)
                        }

                        const rawTemp = messageData.substring(10, 14);
                        const rawHumidity = messageData.substring(14, 18);
                        const rawAdcMax = messageData.substring(22, 26);
                        const rawAdcIn = messageData.substring(26);

                        message.payload = {
                            ...message.payload,
                            ...conectricUsbGateway.calculateTemperature(rawTemp),
                            humidity: conectricUsbGateway.calculateHumidity(rawHumidity),
                            adcIn: rawAdcIn,
                            adcMax: rawAdcMax
                        }

                        if (conectricUsbGateway.params.debugMode) {
                            console.log(`Raw adc in: ${rawAdcIn}`);
                            console.log(`Raw adc max: ${rawAdcMax}`);
                            console.log(`Raw battery: ${messageData.substring(18, 22)}`);
                        }
                    } break;
                case 'tempHumidityLight':
                    {
                        message.payload.battery = battery;

                        if (conectricUsbGateway.params.sendEventCount) {
                            message.payload.eventCount = parseInt(messageData.substring(2, 10), 16);
                        } 

                        const rawTemp = messageData.substring(10, 14);
                        const rawHumidity = messageData.substring(14, 18);
                        const rawAdcMax = messageData.substring(22, 26);
                        const rawAdcIn = messageData.substring(26);

                        const lux = roundTo(0.003 * Math.pow(parseInt(rawAdcIn, 16),  (1.89 - (3.7 - battery) / 25)), 0);

                        let bucketedLux = Math.round(lux / 100);

                        if (bucketedLux > 15) { 
                            bucketedLux = 15;
                        }

                        message.payload = {
                            ...message.payload,
                            ...conectricUsbGateway.calculateTemperature(rawTemp),
                            humidity: conectricUsbGateway.calculateHumidity(rawHumidity),
                            bucketedLux
                        };

                        if (conectricUsbGateway.params.sendRawLux) {
                            message.payload.lux = lux;
                        }

                        if (conectricUsbGateway.params.sendAdcWithLux) {
                            message.payload.adcIn = rawAdcIn;
                            message.payload.adcMax = rawAdcMax;
                        }

                        if (conectricUsbGateway.params.debugMode) {
                            console.log(`Raw adc in: ${rawAdcIn}`);
                            console.log(`Raw adc max: ${rawAdcMax}`);
                            console.log(`Raw battery: ${messageData.substring(18, 22)}`);
                        }
                    } break;
                case 'moisture':
                    message.payload.battery = battery;

                    // This is a new protocol only sensor, so event count
                    // data will always be present...

                    if (messageData.startsWith('21') || messageData.startsWith('22')) {
                        // This is a status report not an actual event.
                        if (! conectricUsbGateway.params.sendStatusMessages) {
                            // Not sending status message to callback.
                            return;
                        }

                        message.type = 'moistureStatus';

                        message.payload = { 
                            ...message.payload, 
                            moisture: messageData.startsWith('21'),
                            ...conectricUsbGateway.calculateTemperature(messageData.substring(10, 14)), 
                            humidity: conectricUsbGateway.calculateHumidity(messageData.substring(14))
                        };

                    } else {
                        // 81 = event caused because now wet where was dry.
                        // 82 = event caused because now dry where was wet.
                        message.payload.moisture = messageData.startsWith('81');
                    }

                    if (conectricUsbGateway.params.sendEventCount) {
                        message.payload.eventCount = parseInt(messageData.substring(2, 10), 16)
                    }

                    break;
                case 'motion':
                    message.payload.battery = battery;

                    if (messageData.startsWith('20')) {
                        // This is a status report not an actual event.
                        if (! conectricUsbGateway.params.sendStatusMessages) {
                            // Not sending status message to callback.
                            return;
                        }

                        message.type = 'motionStatus';
                    } else {
                        // Only indicate motion for real motion events.
                        message.payload.motion = true;
                    }

                    // Add eventCount for messages that have it.
                    if (messageData.length === 10 && conectricUsbGateway.params.sendEventCount) {
                        message.payload.eventCount = parseInt(messageData.substring(2), 16)
                    }

                    break;
                case 'switch':
                    message.payload.battery = battery;

                    // Add eventCount for messages that have it.
                    if (messageData.length === 10 && conectricUsbGateway.params.sendEventCount) {
                        message.payload.eventCount = parseInt(messageData.substring(2), 16)
                    }

                    if ((messageData.startsWith('21')) || (messageData.startsWith('22'))) {
                        // This is a status report not an actual event.
                        if (! conectricUsbGateway.params.sendStatusMessages) {
                            // Not sending status message to callback.
                            return;
                        }

                        message.type = 'switchStatus';
                        message.payload.switch = (conectricUsbGateway.params.switchOpenValue ? (messageData.startsWith('21')) : (messageData.startsWith('22')));
                    } else {
                        // This is an actual switch event.
                        message.payload.switch = (conectricUsbGateway.params.switchOpenValue ? (messageData.startsWith('81')) : (messageData.startsWith('82')));
                    }

                    break;
                case 'boot': 
                    if (conectricUsbGateway.params.sendBootMessages) {
                        message.payload.battery = battery;
                        
                        switch (messageData) {
                            case '00':
                                message.payload.resetCause = 'powerOn';
                                break;
                            case '01':
                                message.payload.resetCause = 'externalReset';
                                break;
                            case '02':
                                message.payload.resetCause = 'watchdogReset';
                                break;
                            default:
                                // Unknown
                                message.payload.resetCause = 'unknown';

                                if (conectricUsbGateway.params.debugMode) {
                                    console.error(`Boot message received with unknown reset cause "${messageData}", full message was "${data}".`)
                                }
                        }
                    } else {
                        // Not sending boot message to callback.
                        return;
                    }

                    break;
                case 'rs485Config':
                    if (messageData.length !== 7) {
                        if (conectricUsbGateway.params.debugMode) {
                            console.error(`Ignoring rs485Config message with payload length ${messageData.length}, was expecting length 7.`);
                        }

                        return;
                    }

                    let baudRate = messageData.substring(0, 2);
                    let parity = messageData.substring(2, 4);
                    let stopBits = messageData.substring(4, 6);
                    let bitMask = messageData.substring(6);

                    switch (baudRate) {
                        case '00':
                            message.payload.baudRate = '2400';
                            break;
                        case '01':
                            message.payload.baudRate = '4800';
                            break;
                        case '02':
                            message.payload.baudRate = '9600';
                            break;
                        case '03':
                            message.payload.baudRate = '19200';
                            break;
                        default:
                            message.payload.baudRate = '?';
                            if (conectricUsbGateway.params.debugMode) {
                                console.error(`Invalid baudRate received in rs485Config message, hex was "${baudRate}".`);
                            }
                    }

                    switch (parity) {
                        case '00':
                            message.payload.parity = conectricUsbGateway.PARITY_NONE;
                            break;
                        case '01':
                            message.payload.parity = conectricUsbGateway.PARITY_ODD;
                            break;
                        case '02':
                            message.payload.parity = conectricUsbGateway.PARITY_EVEN;
                            break;
                        default:
                            message.payload.parity = '?';
                            if (conectricUsbGateway.params.debugMode) {
                                console.error(`Invalid parity received in rs485Config message, hex was "${parity}".`);
                            }
                    }

                    switch (stopBits) {
                        case '00':
                            message.payload.stopBits = 1;
                            break;
                        case '01':
                            message.payload.stopBits = 2;
                            break;
                        default:
                            message.payload.stopBits = -1;
                            if (conectricUsbGateway.params.debugMode) {
                                console.error(`Invalid stopBits received in rs485Config message, hex was "${stopBits}".`);
                            }
                    }

                    switch (bitMask) {
                        case '00':
                            message.payload.bitMask = 8;
                            break;
                        case '01':
                            message.payload.bitMask = 7;
                            break;
                        default:
                            message.payload.bitMask = -1;
                            if (conectricUsbGateway.params.debugMode) {
                                console.error(`Invalid bitMask received in rs485Config message, hex was "${bitMask}".`);
                            }
                    }
            
                    break;
                case 'rs485Request':
                    message.payload.data = messageData;
                    break;
                case 'rs485Response':
                    message.payload.battery = battery;
                    message.payload.rs485 = messageData;
                    break;
                case 'rs485ChunkEnvelopeResponse':
                    message.payload.battery = battery;
                    message.payload.numChunks = parseInt(messageData.substring(0, 2), 16);
                    message.payload.chunkSize = parseInt(messageData.substring(2), 16);
                    break;
                case 'rs485ChunkResponse':
                    message.payload.battery = battery;
                    message.payload.data = messageData;
                    break;
                case 'text':
                    message.payload.battery = battery;

                    if (conectricUsbGateway.params.decodeTextMessages) {
                        message.payload.text = conectricUsbGateway.hexDecode(messageData);
                    } else {
                        message.payload.text = messageData;
                    }
                    break;
                default:
                    if (conectricUsbGateway.params.debugMode) {
                        console.log(`Ignoring unknown message type "${messageType}"`);
                    }
            }
        }

        conectricUsbGateway.params.onSensorMessage(message);
    }
}

module.exports = conectricUsbGateway;
