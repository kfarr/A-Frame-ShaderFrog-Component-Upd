AFRAME.registerSystem('shader-frog', {
  init:function(){
    this.frog_runtime = new ShaderRuntime();
    this.clock = new THREE.Clock();
    var self = this;
        
    var scene = document.querySelector('a-scene');
    if (scene.hasLoaded) {
      registerCamera().bind(this);;
    } else {
      scene.addEventListener('loaded', registerCamera);
    }
    function registerCamera () {
       var camera = document.querySelector("a-scene").systems["camera"];
       if(camera && camera.sceneEl && camera.sceneEl.camera){
         camera = camera.sceneEl.camera;
         self.frog_runtime.registerCamera(camera);
       }
    }
  },
  tick: function (t) {
    this.frog_runtime.updateShaders( this.clock.getElapsedTime() );
  }
});
AFRAME.registerComponent('shader-frog',{
  schema:{
    src:{type:"asset"}
  },
  init: function(){
    this.originalMaterial = this.el.getObject3D('mesh').material;
  },
  update: function(){
    this.system.frog_runtime.load(this.data.src,function(shaderData){
      var material = this.system.frog_runtime.get(shaderData.name);
      this.el.getObject3D('mesh').material = material;
    }.bind(this));
  },
  remove: function(){
    this.el.getObject3D('mesh').material = this.originalMaterial;
  }
});

let defaultThreeUniforms = [
    'normalMatrix', 'viewMatrix', 'projectionMatrix', 'position', 'normal',
    'modelViewMatrix', 'uv', 'uv2', 'modelMatrix'
];

function ShaderRuntime() {}

ShaderRuntime.prototype = {

    mainCamera: null,
    cubeCameras: {},

    reserved: { time: null, cameraPosition: null },

    umap: {
        float: { type: 'f', value: 0 },
        int: { type: 'i', value: 0 },
        vec2: { type: 'v2', value() { return new THREE.Vector2(); } },
        vec3: { type: 'v3', value() { return new THREE.Vector3(); } },
        vec4: { type: 'v4', value() { return new THREE.Vector4(); } },
        samplerCube: { type: 't' },
        sampler2D: { type: 't' }
    },

    getUmap( type ) {
        let value = this.umap[ type ].value;
        return typeof value === 'function' ? value() : value;
    },

    load( sourceOrSources, callback ) {

        let sources = sourceOrSources,
            onlyOneSource = typeof sourceOrSources === 'string';

        if( onlyOneSource ) {
            sources = [ sourceOrSources ];
        }

        let loadedShaders = new Array( sources.length ),
            itemsLoaded = 0;

        let loadSource = ( index, source ) => {

            let loader = new THREE.FileLoader();
            loader.load( source, ( json ) => {

                let parsed;
                try {
                    parsed = JSON.parse( json );
                    delete parsed.id; // Errors if passed to rawshadermaterial :(
                } catch( e ) {
                    throw new Error( 'Could not parse shader' + source + '! Please verify the URL is correct.' );
                }
                this.add( parsed.name, parsed );
                loadedShaders[ index ] = parsed;

                if( ++itemsLoaded === sources.length ) {
                    callback( onlyOneSource ? loadedShaders[ 0 ] : loadedShaders );
                }

            });
        };

        for( let x = 0; x < sources.length; x++ ) {
            loadSource( x, sources[ x ] );
        }

    },

    registerCamera( camera ) {

        if( !( camera instanceof THREE.Camera ) ) {
            throw new Error( 'Cannot register a non-camera as a camera!' );
        }

        this.mainCamera = camera;

    },

    registerCubeCamera( name, camera ) {

        if( !camera.renderTarget ) {
            throw new Error( 'Cannot register a non-camera as a camera!' );
        }

        this.cubeCameras[ name ] = camera;

    },

    unregisterCamera( name ) {

        if( name in this.cubeCameras ) {

            delete this.cubeCameras[ name ];
            
        } else if( name === this.mainCamera ) {

            delete this.mainCamera;

        } else {

            throw new Error( 'You never registered camera ' + name );

        }

    },

    updateSource( identifier, config, findBy ) {

        findBy = findBy || 'name';

        if( !this.shaderTypes[ identifier ] ) {
            throw new Error( 'Runtime Error: Cannot update shader ' + identifier + ' because it has not been added.' );
        }

        let newShaderData = this.add( identifier, config ),
            shader, x;

        for( x = 0; shader = this.runningShaders[ x++ ]; ) {
            if( shader[ findBy ] === identifier ) {
                extend( shader.material, omit( newShaderData, 'id' ) );
                shader.material.needsUpdate = true;
            }
        }

    },

    renameShader( oldName, newName ) {

        let x, shader;

        if( !( oldName in this.shaderTypes ) ) {
            throw new Error('Could not rename shader ' + oldName + ' to ' + newName + '. It does not exist.');
        }

        this.shaderTypes[ newName ] = this.shaderTypes[ oldName ];
        delete this.shaderTypes[ oldName ];

        for( x = 0; shader = this.runningShaders[ x++ ]; ) {
            if( shader.name === oldName ) {
                shader.name = newName;
            }
        }

    },

    get( identifier ) {

        let shaderType = this.shaderTypes[ identifier ];

        if( !shaderType.initted ) {

            this.create( identifier );
        }

        return shaderType.material;

    },

    add( shaderName, config ) {

        let newData = clone( config ),
            uniform;
        newData.fragmentShader = config.fragment;
        newData.vertexShader = config.vertex;
        delete newData.fragment;
        delete newData.vertex;

        for( var uniformName in newData.uniforms ) {
            uniform = newData.uniforms[ uniformName ];
            if( uniform.value === null ) {
                newData.uniforms[ uniformName ].value = this.getUmap( uniform.glslType );
            }
        }
        
        if( shaderName in this.shaderTypes ) {
            // maybe not needed? too sleepy, need document
            extend( this.shaderTypes[ shaderName ], newData );
        } else {
            this.shaderTypes[ shaderName ] = newData;
        }

        return newData;

    },

    create( identifier ) {

        let shaderType = this.shaderTypes[ identifier ];

        shaderType.material = new THREE.RawShaderMaterial( shaderType );

        this.runningShaders.push( shaderType );

        shaderType.init && shaderType.init( shaderType.material );
        shaderType.material.needsUpdate = true;

        shaderType.initted = true;

        return shaderType.material;

    },

    updateRuntime( identifier, data, findBy ) {

        findBy = findBy || 'name';

        let shader, x, uniformName, uniform;

        // This loop does not appear to be a slowdown culprit
        for( x = 0; shader = this.runningShaders[ x++ ]; ) {
            if( shader[ findBy ] === identifier ) {
                for( uniformName in data.uniforms ) {

                    if( uniformName in this.reserved ) {
                        continue;
                    }

                    if( uniformName in shader.material.uniforms ) {

                        uniform = data.uniforms[ uniformName ];

                        // this is nasty, since the shader serializes
                        // CubeCamera model to string. Maybe not update it at
                        // all?
                        if( uniform.type === 't' && typeof uniform.value === 'string' ) {
                            uniform.value = this.cubeCameras[ uniform.value ].renderTarget;
                        }

                        shader.material.uniforms[ uniformName ].value = data.uniforms[ uniformName ].value;
                    }
                }
            }
        }

    },

    // Update global shader uniform values
    updateShaders( time, obj ) {

        let shader, x;

        obj = obj || {};

        for( x = 0; shader = this.runningShaders[ x++ ]; ) {

            for( let uniform in obj.uniforms ) {
                if( uniform in shader.material.uniforms ) {
                    shader.material.uniforms[ uniform ].value = obj.uniforms[ uniform ];
                }
            }

            if( 'cameraPosition' in shader.material.uniforms && this.mainCamera ) {

                shader.material.uniforms.cameraPosition.value = this.mainCamera.position.clone();

            }

            if( 'viewMatrix' in shader.material.uniforms && this.mainCamera ) {

                shader.material.uniforms.viewMatrix.value = this.mainCamera.matrixWorldInverse;

            }

            if( 'time' in shader.material.uniforms ) {

                shader.material.uniforms.time.value = time;

            }

        }

    },

    shaderTypes: {},

    runningShaders: []

};

// Convenience methods so we don't have to include underscore
function extend() {
    let length = arguments.length,
        obj = arguments[ 0 ];

    if( length < 2 ) {
        return obj;
    }

    for( let index = 1; index < length; index++ ) {
        let source = arguments[ index ],
            keys = Object.keys( source || {} ),
            l = keys.length;
        for( let i = 0; i < l; i++ ) {
            let key = keys[i];
            obj[ key ] = source[ key ];
        }
    }

    return obj;
}

function clone( obj ) {
    return extend( {}, obj );
}

function omit( obj, ...keys ) {
    let cloned = clone( obj ), x, key;
    for( x = 0; key = keys[ x++ ]; ) {
        delete cloned[ key ];
    }
    return cloned;
}