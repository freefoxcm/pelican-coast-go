import {
	Color
} from 'three';

/**
 * Luminosity
 * http://en.wikipedia.org/wiki/Luminosity
 */

const LuminosityHighPassShader = {

	name: 'LuminosityHighPassShader',

	shaderID: 'luminosityHighPass',

	uniforms: {

		'tDiffuse': { value: null },
		'luminosityThreshold': { value: 1.0 },
		'smoothWidth': { value: 1.0 },
		'defaultColor': { value: new Color( 0x000000 ) },
		'defaultOpacity': { value: 0.0 }

	},

	vertexShader: /* glsl */`

		varying vec2 vUv;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );

		}`,

	fragmentShader: /* glsl */`

		uniform sampler2D tDiffuse;
		uniform vec3 defaultColor;
		uniform float defaultOpacity;
		uniform float luminosityThreshold;
		uniform float smoothWidth;

		varying vec2 vUv;

		// Pelican Coast Go guard: a single NaN/Inf pixel (e.g. from a degenerate
		// triangle with flat shading) would be smeared over the whole mip chain
		// and black out the frame. Sanitise before it enters the blur.
		vec4 sanitize( vec4 c ) {
			if ( c.r != c.r || abs( c.r ) > 1.0e6 ) c.r = 0.0;
			if ( c.g != c.g || abs( c.g ) > 1.0e6 ) c.g = 0.0;
			if ( c.b != c.b || abs( c.b ) > 1.0e6 ) c.b = 0.0;
			return c;
		}

		void main() {

			vec4 texel = sanitize( texture2D( tDiffuse, vUv ) );

			float v = luminance( texel.xyz );

			vec4 outputColor = vec4( defaultColor.rgb, defaultOpacity );

			float alpha = smoothstep( luminosityThreshold, luminosityThreshold + smoothWidth, v );

			gl_FragColor = mix( outputColor, texel, alpha );

		}`

};

export { LuminosityHighPassShader };
