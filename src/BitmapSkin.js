const twgl = require('twgl.js');

const Skin = require('./Skin');

class BitmapSkin extends Skin {
    /**
     * Create a new Bitmap Skin.
     * @extends Skin
     * @param {!int} id - The ID for this Skin.
     * @param {!RenderWebGL} renderer - The renderer which will use this skin.
     */
    constructor (id, renderer) {
        super(id);

        /** @type {!int} */
        this._costumeResolution = 1;

        /** @type {!RenderWebGL} */
        this._renderer = renderer;

        /**
         * The "native" size, in terms of "stage pixels", of this skin.
         * @type {Array<number>}
         */
        this.nativeSize = [0, 0];

        /**
         * The size of this skin's actual texture, aka the dimensions of the actual rendered
         * quadrilateral at 1x scale, in "stage pixels".
         * @type {Array<number>}
         */
        this.quadSize = this.nativeSize;
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        if (this._texture) {
            this._renderer.gl.deleteTexture(this._texture);
            this._texture = null;
        }
        super.dispose();
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used.
     * @return {WebGLTexture} The GL texture representation of this skin when drawing at the given scale.
     */
    // eslint-disable-next-line no-unused-vars
    getTexture (scale) {
        return this._texture || super.getTexture();
    }

    /**
     * Set the contents of this skin to a snapshot of the provided bitmap data.
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - new contents for this skin.
     * @param {int} [costumeResolution=1] - The resolution to use for this bitmap.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the bitmap. If not supplied, it will be
     * calculated from the bounding box
     * @fires Skin.event:WasAltered
     */
    setBitmap (bitmapData, costumeResolution, rotationCenter) {
        if (!bitmapData.width || !bitmapData.height) {
            super.setEmptyImageData();
            return;
        }
        const gl = this._renderer.gl;

        // Preferably bitmapData is ImageData. ImageData speeds up updating
        // Silhouette and is better handled by more browsers in regards to
        // memory.
        let textureData = bitmapData;
        if (bitmapData instanceof HTMLCanvasElement) {
            // Given a HTMLCanvasElement get the image data to pass to webgl and
            // Silhouette.
            const context = bitmapData.getContext('2d');
            textureData = context.getImageData(0, 0, bitmapData.width, bitmapData.height);
        }

        if (this._texture === null) {
            const textureOptions = {
                auto: false,
                wrap: gl.CLAMP_TO_EDGE
            };

            this._texture = twgl.createTexture(gl, textureOptions);
        }

        this._setTexture(textureData);

        // Do these last in case any of the above throws an exception
        this._costumeResolution = costumeResolution || 2;
        const [width, height] = BitmapSkin._getBitmapSize(bitmapData);
        // Because we assigned this.quadSize to this.nativeSize, set this.nativeSize's items instead of reassigning the
        // reference
        this.nativeSize[0] = width / this._costumeResolution;
        this.nativeSize[1] = height / this._costumeResolution;

        if (typeof rotationCenter === 'undefined') rotationCenter = this._calculateRotationCenter();
        this._nativeRotationCenter[0] = rotationCenter[0];
        this._nativeRotationCenter[1] = rotationCenter[1];

        this.emit(Skin.Events.WasAltered);
    }

    /**
     * @param {ImageData|HTMLImageElement|HTMLCanvasElement|HTMLVideoElement} bitmapData - bitmap data to inspect.
     * @returns {Array<int>} the width and height of the bitmap data, in pixels.
     * @private
     */
    static _getBitmapSize (bitmapData) {
        if (bitmapData instanceof HTMLImageElement) {
            return [bitmapData.naturalWidth || bitmapData.width, bitmapData.naturalHeight || bitmapData.height];
        }

        if (bitmapData instanceof HTMLVideoElement) {
            return [bitmapData.videoWidth || bitmapData.width, bitmapData.videoHeight || bitmapData.height];
        }

        // ImageData or HTMLCanvasElement
        return [bitmapData.width, bitmapData.height];
    }

}

module.exports = BitmapSkin;
