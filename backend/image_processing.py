import cv2


def preprocess_image(image_path):

    # Read image
    image = cv2.imread(image_path)

    # Convert to grayscale
    gray = cv2.cvtColor(
        image,
        cv2.COLOR_BGR2GRAY
    )

    # Remove noise
    blurred = cv2.GaussianBlur(
        gray,
        (5, 5),
        0
    )

    # Convert to black and white
    thresh = cv2.threshold(
        blurred,
        150,
        255,
        cv2.THRESH_BINARY
    )[1]

    return thresh