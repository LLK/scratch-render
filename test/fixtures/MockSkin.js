const Skin = require('../../src/Skin');

class MockSkin extends Skin {
    set size (dimensions) {
        this.dimensions = dimensions;
    }

    get nativeSize () {
        return this.dimensions || [0, 0];
    }

    get quadSize () {
        return this.dimensions || [0, 0];
    }

    set rotationCenter (center) {
        this._nativeRotationCenter[0] = center[0];
        this._nativeRotationCenter[1] = center[1];
        this.emit(Skin.Events.WasAltered);
    }

    get nativeRotationCenter () {
        return this._nativeRotationCenter;
    }

    get quadRotationCenter () {
        return this._nativeRotationCenter;
    }
}

module.exports = MockSkin;
