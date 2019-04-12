// Basic example, logs messages received from sensors through the gateway.

const gateway = require('conectric-usb-gateway-beta');

gateway.runGateway({
    onSensorMessage: (sensorMessage) => {
        console.log(sensorMessage);
    }
});