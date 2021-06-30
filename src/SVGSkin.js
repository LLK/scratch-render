const twgl = require('twgl.js');

const Skin = require('./Skin');
const {loadSvgString, serializeSvgToString} = require('scratch-svg-renderer');
const ShaderManager = require('./ShaderManager');

const MAX_TEXTURE_DIMENSION = 2048;

/**
 * All scaled renderings of the SVG are stored in an array. The 1.0 scale of
 * the SVG is stored at the 3rd index. The smallest possible 1 / 8 scale
 * rendering is stored at the 0th index.
 * @const {number}
 */
const INDEX_OFFSET = 3;
const MIN_TEXTURE_SCALE = 1 / (1 << INDEX_OFFSET);

class SVGSkin extends Skin {
    /**
     * Create a new SVG skin.
     * @param {!int} id - The ID for this Skin.
     * @param {!RenderWebGL} renderer - The renderer which will use this skin.
     * @constructor
     * @extends Skin
     */
    constructor (id, renderer) {
        super(id);

        /** @type {RenderWebGL} */
        this._renderer = renderer;

        /** @type {HTMLImageElement} */
        this._svgImage = document.createElement('img');

        /** @type {boolean} */
        this._svgImageLoaded = false;

        /** @type {HTMLCanvasElement} */
        this._canvas = document.createElement('canvas');

        /** @type {CanvasRenderingContext2D} */
        this._context = this._canvas.getContext('2d');

        /** @type {Array<WebGLTexture>} */
        this._scaledMIPs = [];

        /**
         * The "native" size, in terms of "stage pixels", of this skin.
         * @type {Array<number>}
         */
        this.nativeSize = [0, 0];

        /**
         * The size of this skin's actual texture, aka the dimensions of the actual rendered
         * quadrilateral at 1x scale, in "stage pixels". To properly handle positioning of vector sprites' viewboxes,
         * some "slack space" is added to this size, but not to the nativeSize.
         * @type {Array<number>} */
        this.quadSize = [0, 0];

        /** @type {Array<number>} */
        this._quadRotationCenter = [0, 0];

        /** @type {number} */
        this._largestMIPScale = 0;

        /**
        * Ratio of the size of the SVG and the max size of the WebGL texture
        * @type {Number}
        */
        this._maxTextureScale = 1;
    }

    /**
     * Dispose of this object. Do not use it after calling this method.
     */
    dispose () {
        this.resetMIPs();
        super.dispose();
    }

    get quadRotationCenter () {
        return this._quadRotationCenter;
    }

    useNearest (scale, drawable) {
        // If the effect bits for mosaic, pixelate, whirl, or fisheye are set, use linear
        if ((drawable.enabledEffects & (
            ShaderManager.EFFECT_INFO.fisheye.mask |
            ShaderManager.EFFECT_INFO.whirl.mask |
            ShaderManager.EFFECT_INFO.pixelate.mask |
            ShaderManager.EFFECT_INFO.mosaic.mask
        )) !== 0) {
            return false;
        }

        // We can't use nearest neighbor unless we are a multiple of 90 rotation
        if (drawable._direction % 90 !== 0) {
            return false;
        }

        // Because SVG skins' bounding boxes are currently not pixel-aligned, the idea here is to hide blurriness
        // by using nearest-neighbor scaling if one screen-space pixel is "close enough" to one texture pixel.
        // If the scale of the skin is very close to 100 (0.99999 variance is okay I guess)
        // TODO: Make this check more precise. We should use nearest if there's less than one pixel's difference
        // between the screen-space and texture-space sizes of the skin. Mipmaps make this harder because there are
        // multiple textures (and hence multiple texture spaces) and we need to know which one to choose.
        if (Math.abs(scale[0]) > 99 && Math.abs(scale[0]) < 101 &&
            Math.abs(scale[1]) > 99 && Math.abs(scale[1]) < 101) {
            return true;
        }
        return false;
    }

    /**
     * Create a MIP for a given scale.
     * @param {number} scale - The relative size of the MIP
     * @return {SVGMIP} An object that handles creating and updating SVG textures.
     */
    createMIP (scale) {
        const [width, height] = this.quadSize;
        this._canvas.width = width * scale;
        this._canvas.height = height * scale;
        this._context.clearRect(0, 0, this._canvas.width, this._canvas.height);
        this._context.setTransform(scale, 0, 0, scale, 0, 0);
        this._context.drawImage(this._svgImage, 0, 0);

        // Pull out the ImageData from the canvas. ImageData speeds up
        // updating Silhouette and is better handled by more browsers in
        // regards to memory.
        const textureData = this._context.getImageData(0, 0, this._canvas.width, this._canvas.height);

        const textureOptions = {
            auto: false,
            wrap: this._renderer.gl.CLAMP_TO_EDGE,
            src: textureData,
            premultiplyAlpha: true
        };

        const mip = twgl.createTexture(this._renderer.gl, textureOptions);

        // Check if this is the largest MIP created so far. Currently, silhouettes only get scaled up.
        if (this._largestMIPScale < scale) {
            this._silhouette.update(textureData);
            this._largestMIPScale = scale;
        }

        return mip;
    }

    updateSilhouette (scale = [100, 100]) {
        // Ensure a silhouette exists.
        this.getTexture(scale);
    }

    /**
     * @param {Array<number>} scale - The scaling factors to be used, each in the [0,100] range.
     * @return {WebGLTexture} The GL texture representation of this skin when drawing at the given scale.
     */
    getTexture (scale) {
        // The texture only ever gets uniform scale. Take the larger of the two axes.
        const scaleMax = scale ? Math.max(Math.abs(scale[0]), Math.abs(scale[1])) : 100;
        const requestedScale = Math.min(scaleMax / 100, this._maxTextureScale);

        // Math.ceil(Math.log2(scale)) means we use the "1x" texture at (0.5, 1] scale,
        // the "2x" texture at (1, 2] scale, the "4x" texture at (2, 4] scale, etc.
        // This means that one texture pixel will always be between 0.5x and 1x the size of one rendered pixel,
        // but never bigger than one rendered pixel--this prevents blurriness from blowing up the texture too much.
        const mipLevel = Math.max(Math.ceil(Math.log2(requestedScale)) + INDEX_OFFSET, 0);
        // Can't use bitwise stuff here because we need to handle negative exponents
        const mipScale = Math.pow(2, mipLevel - INDEX_OFFSET);

        if (this._svgImageLoaded && !this._scaledMIPs[mipLevel]) {
            this._scaledMIPs[mipLevel] = this.createMIP(mipScale);
        }

        return this._scaledMIPs[mipLevel] || super.getTexture();
    }

    /**
     * Do a hard reset of the existing MIPs by deleting them.
     */
    resetMIPs () {
        this._scaledMIPs.forEach(oldMIP => this._renderer.gl.deleteTexture(oldMIP));
        this._scaledMIPs.length = 0;
        this._largestMIPScale = 0;
    }

    /**
     * Set the loaded SVG's viewBox and this renderer's viewOffset for proper subpixel positioning.
     * @param {SVGSVGElement} svgTag The SVG element to adjust
     */
    _setSubpixelViewbox (svgTag) {
        const {x, y, width, height} = svgTag.viewBox.baseVal;
        const rotationCenter = this._nativeRotationCenter;

        // The preserveAspectRatio attribute has all sorts of weird effects on the viewBox if enabled.
        svgTag.setAttribute('preserveAspectRatio', 'none');

        // Multiplied by the minimum drawing scale.
        const center = [
            (
                rotationCenter[0]
                // Compensate for viewbox offset.
                // See https://github.com/LLK/scratch-render/pull/90.
                // eslint-disable-next-line operator-linebreak
                - x
            ) * MIN_TEXTURE_SCALE,

            (rotationCenter[1] - y) * MIN_TEXTURE_SCALE
        ];

        // Take the fractional part of the scaled rotation center.
        // We will translate the viewbox by this amount later for proper subpixel positioning.
        const centerFrac = [
            (center[0] % 1),
            (center[1] % 1)
        ];

        // Scale the viewbox dimensions by the minimum scale, add the offset, then take the ceiling
        // to get the rendered size (scaled by MIN_TEXTURE_SCALE).
        const scaledSize = [
            Math.ceil((width * MIN_TEXTURE_SCALE) + (1 - centerFrac[0])),
            Math.ceil((height * MIN_TEXTURE_SCALE) + (1 - centerFrac[1]))
        ];

        // Scale back up to the SVG size.
        const adjustedSize = [
            scaledSize[0] / MIN_TEXTURE_SCALE,
            scaledSize[1] / MIN_TEXTURE_SCALE
        ];

        this.quadSize = adjustedSize;

        const xOffset = ((1 - centerFrac[0]) / MIN_TEXTURE_SCALE);
        const yOffset = ((1 - centerFrac[1]) / MIN_TEXTURE_SCALE);

        this._quadRotationCenter = [
            (center[0] / MIN_TEXTURE_SCALE) + xOffset,
            (center[1] / MIN_TEXTURE_SCALE) + yOffset
        ];

        // Set "logical bounds" as fractions of the adjusted bounding box size
        /** @see Skin.logicalBounds */
        this._uniforms.u_logicalBounds[0] = xOffset / adjustedSize[0];
        this._uniforms.u_logicalBounds[1] = yOffset / adjustedSize[1];
        this._uniforms.u_logicalBounds[2] = (width + xOffset) / adjustedSize[0];
        this._uniforms.u_logicalBounds[3] = (height + yOffset) / adjustedSize[1];

        // Adjust the SVG tag's viewbox to match the texture dimensions and offset.
        // This will ensure that the SVG is rendered at the proper sub-pixel position,
        // and with integer dimensions at power-of-two sizes down to MIN_TEXTURE_SCALE.
        svgTag.setAttribute('viewBox',
            `${
                x - xOffset
            } ${
                y - yOffset
            } ${
                adjustedSize[0]
            } ${
                adjustedSize[1]
            }`);

        svgTag.setAttribute('width', adjustedSize[0]);
        svgTag.setAttribute('height', adjustedSize[1]);
    }

    /**
     * Set the contents of this skin to a snapshot of the provided SVG data.
     * @param {string} svgData - new SVG to use.
     * @param {Array<number>} [rotationCenter] - Optional rotation center for the SVG. If not supplied, it will be
     * calculated from the bounding box
     * @fires Skin.event:WasAltered
     */
    setSVG (svgData, rotationCenter) {
        const svgTag = loadSvgString(svgData);

        // Handle zero-size skins. _setSubpixelViewbox will handle really really small skins whose dimensions would
        // otherwise be rounded down to 0.
        const {width, height} = svgTag.viewBox.baseVal;
        if (width === 0 || height === 0) {
            super.setEmptyImageData();
            this._quadRotationCenter[0] = 0;
            this._quadRotationCenter[1] = 0;
            return;
        }
        this.nativeSize[0] = width;
        this.nativeSize[1] = height;
        if (typeof rotationCenter === 'undefined') rotationCenter = this._calculateRotationCenter();
        this._nativeRotationCenter[0] = rotationCenter[0];
        this._nativeRotationCenter[1] = rotationCenter[1];

        this._setSubpixelViewbox(svgTag);
        const svgText = serializeSvgToString(svgTag, true /* shouldInjectFonts */);
        this._svgImageLoaded = false;

        // If there is another load already in progress, replace the old onload to effectively cancel the old load
        this._svgImage.onload = () => {
            const maxDimension = Math.ceil(Math.max(width, height));
            let testScale = 2;
            for (testScale; maxDimension * testScale <= MAX_TEXTURE_DIMENSION; testScale *= 2) {
                this._maxTextureScale = testScale;
            }

            this.resetMIPs();
            this._svgImageLoaded = true;
            // While we're setting the size and rotation center before the image is loaded, this doesn't cause the skin
            // to appear in the wrong place/with the wrong size for a few frames while the new image is loading, because
            // we don't emit this event, telling drawables using this skin to update, until the image is loaded.
            this.emit(Skin.Events.WasAltered);
        };

        this._svgImage.src = `data:image/svg+xml;utf8,${encodeURIComponent(svgText)}`;
    }

}

module.exports = SVGSkin;
