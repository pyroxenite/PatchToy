# TODO
 - Custom UI
 - Custom default values for inputs
 - Resizable nodes
 - Special node style for uniforms
 - JS computation nodes for more complex scenarios
   - Manipulate more complexe objects on the CPU side
   - Run simulations etc...
   - Must output to uniforms
   - Either a new type of unform node or a new type of connection with a JS value to uniform adaptor
 - More uniforms:
   - Midi
   - BPM tracking
   - Frequency bands
   - Buttons
   - Keyboard
 - More modules:
   - Basic transforms
 - User accounts with backend and basic token based auth
   - Save projects (public link or private only)
   - Save custom nodes (public or private)
     - When importing a public node, we copy it to the project so that external modifications of the node don't affect the new project and internal modifications of the node don't affect other projects that use the node... more clarification needed. how do we build a shared node system (shared accross user projects and users)?
 - When in full screen mode, switch between different output/preview nodes



# Bugs
 - When copying and pasting, the connection swivling isn't preserved 
 - The text baseline shifts randomly...